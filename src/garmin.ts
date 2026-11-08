import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const GarminSessionSchema = z.object({
  di_token: z.string().min(1).max(16000),
  di_refresh_token: z.string().min(1).max(16000),
  di_client_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
});
export type GarminSession = z.infer<typeof GarminSessionSchema>;
export type GarminRead = (path: string, params?: Record<string, string>) => Promise<unknown>;
export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class GarminHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Garmin request failed (HTTP ${status}).`);
  }
}

const nativeHeaders = {
  'User-Agent': 'GCM-Android-5.23',
  'X-Garmin-User-Agent': 'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0',
  'X-Garmin-Paired-App-Version': '10861',
  'X-Garmin-Client-Platform': 'Android',
  'X-App-Ver': '10861',
  'X-Lang': 'en',
  'X-GCExperience': 'GC5',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: 'application/json',
};

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new GarminHttpError(response.status);
  }
  const maxBytes = 2_000_000;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('Garmin response exceeded the size limit.');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (size > maxBytes) throw error;
    throw new Error('Garmin returned an unreadable response.');
  } finally {
    reader.releaseLock();
  }
}

export async function fetchGarmin(
  session: GarminSession,
  path: string,
  params: Record<string, string> = {},
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  if (!/^\/[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(path)) throw new Error('Invalid Garmin API path.');
  const url = new URL(path, 'https://connectapi.garmin.com');
  if (url.origin !== 'https://connectapi.garmin.com') throw new Error('Invalid Garmin API origin.');
  url.search = new URLSearchParams(params).toString();
  const response = await fetcher(url, {
    method: 'GET',
    headers: { ...nativeHeaders, Authorization: `Bearer ${session.di_token}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  return responseJson(response);
}

export async function refreshSession(session: GarminSession, fetcher: Fetcher = fetch): Promise<GarminSession> {
  const response = await fetcher('https://diauth.garmin.com/di-oauth2-service/oauth/token', {
    method: 'POST',
    headers: {
      ...nativeHeaders,
      Authorization: `Basic ${btoa(`${session.di_client_id}:`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: session.di_client_id,
      refresh_token: session.di_refresh_token,
    }).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  const updated = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional() }).safeParse(await responseJson(response));
  if (!updated.success) throw new Error('Garmin returned an invalid refresh response.');
  return GarminSessionSchema.parse({
    di_token: updated.data.access_token,
    di_refresh_token: updated.data.refresh_token ?? session.di_refresh_token,
    di_client_id: session.di_client_id,
  });
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, 'Use a real calendar date in YYYY-MM-DD format.');
const activityId = z.union([z.string().regex(/^[1-9]\d{0,15}$/), z.number().int().positive().safe()]);
const activityType = z.string().regex(/^[a-z_]{1,50}$/).optional();
const rangeShape = { start_date: date, end_date: date };
const activityShape = { start: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(50).default(20), activity_type: activityType };

function record(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error('Garmin returned an unexpected response shape.');
}
function optionalRecord(value: unknown): Record<string, unknown> {
  return value === null || value === undefined ? {} : record(value);
}
function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(key => value[key] !== null && value[key] !== undefined).map(key => [key, value[key]]));
}
function checkRange(start: string, end: string, maximumDays: number): void {
  const days = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
  if (days < 1 || days > maximumDays) throw new Error(`Use an ordered date range of at most ${maximumDays} days.`);
}

export function registerGarminTools(server: McpServer, read: GarminRead): void {
  function tool<T extends z.ZodRawShape>(name: string, description: string, shape: T, run: (args: z.infer<z.ZodObject<T>>) => Promise<unknown>): void {
    const schema = z.object(shape).strict();
    server.registerTool<z.ZodRawShape, typeof schema>(name, {
      description,
      inputSchema: schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (args) => {
      try {
        const result = await run(schema.parse(args));
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        const message = error instanceof GarminHttpError
          ? error.message
          : error instanceof z.ZodError ? 'Invalid tool arguments.' : 'Could not retrieve Garmin data. Try again or reconnect your Garmin session.';
        return { isError: true, content: [{ type: 'text' as const, text: message }] };
      }
    });
  }
  const socialProfile = async (): Promise<Record<string, unknown>> => record(await read('/userprofile-service/socialProfile'));
  const displayName = async (): Promise<string> => {
    const name = (await socialProfile()).displayName;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Missing Garmin profile name.');
    return name;
  };
  const sleep = async (day: string): Promise<unknown> => read(`/wellness-service/wellness/dailySleepData/${await displayName()}`, { date: day, nonSleepBufferMinutes: '60' });
  const summary = async (day: string): Promise<unknown> => {
    const data = record(await read(`/usersummary-service/usersummary/daily/${await displayName()}`, { calendarDate: day }));
    if (Object.keys(data).length === 0 || data.privacyProtected === true) throw new Error('Garmin daily summary is unavailable.');
    return data;
  };
  const activities = async (params: Record<string, string>, start: number, limit: number): Promise<unknown> => {
    const value = await read('/activitylist-service/activities/search/activities', { ...params, start: String(start), limit: String(limit) });
    if (!Array.isArray(value)) throw new Error('Unexpected activity response.');
    return { activities: value, start, limit, count: value.length, has_more: value.length === limit, next_start: value.length === limit ? start + limit : null };
  };
  tool('get_full_name', 'Get the Garmin account holder name.', {}, async () => ({ full_name: (await socialProfile()).fullName ?? null }));
  tool('get_unit_system', 'Get Garmin preferred measurement units.', {}, async () => ({ unit_system: optionalRecord(record(await read('/userprofile-service/userprofile/user-settings')).userData).measurementSystem ?? null }));
  tool('get_user_profile', 'Get Garmin user profile data.', {}, () => read('/userprofile-service/userprofile/user-settings'));
  tool('get_userprofile_settings', 'Get Garmin user profile settings.', {}, () => read('/userprofile-service/userprofile/settings'));
  tool('get_heart_rate_zones', 'Get saved heart-rate zones, optionally for one sport.', { sport: z.string().regex(/^[A-Za-z][A-Za-z0-9_ -]{0,50}$/).optional() }, async ({ sport }) => {
    const zones = await read('/biometric-service/heartRateZones');
    if (!Array.isArray(zones)) throw new Error('Unexpected heart-rate zones.');
    const normalized = sport?.trim().toUpperCase().replace(/[ -]/g, '_');
    const key = normalized === 'GENERIC' ? 'DEFAULT' : normalized;
    return key ? zones.filter(zone => record(zone).sport === key) : zones;
  });
  tool('get_activities', 'Get one page of recent activities. Follow next_start while has_more is true; a full page does not prove more records exist.', activityShape, ({ start, limit, activity_type }) => activities(activity_type ? { activityType: activity_type } : {}, start, limit));
  tool('get_activities_by_date', 'Get one page of activities in an inclusive date range of up to 366 days. Follow next_start until has_more is false.', { ...rangeShape, ...activityShape }, ({ start_date, end_date, start, limit, activity_type }) => {
    checkRange(start_date, end_date, 366);
    return activities({ startDate: start_date, endDate: end_date, ...(activity_type ? { activityType: activity_type } : {}) }, start, limit);
  });
  tool('get_activity', 'Get one activity summary by its Garmin activity ID.', { activity_id: activityId }, ({ activity_id }) => read(`/activity-service/activity/${activity_id}`));
  tool('get_activity_splits', 'Get recorded lap splits for one activity.', { activity_id: activityId }, ({ activity_id }) => read(`/activity-service/activity/${activity_id}/splits`));
  tool('get_body_battery', 'Get daily Body Battery data for up to 28 inclusive days.', rangeShape, ({ start_date, end_date }) => {
    checkRange(start_date, end_date, 28);
    return read('/wellness-service/wellness/bodyBattery/reports/daily', { startDate: start_date, endDate: end_date });
  });
  tool('get_daily_steps', 'Get daily steps for up to 28 inclusive days.', rangeShape, ({ start_date, end_date }) => {
    checkRange(start_date, end_date, 28);
    return read(`/usersummary-service/stats/steps/daily/${start_date}/${end_date}`);
  });
  tool('get_stats', 'Get daily Garmin health and activity statistics.', { date }, ({ date }) => summary(date));
  tool('get_user_summary', 'Get daily Garmin user summary.', { date }, ({ date }) => summary(date));
  tool('get_training_readiness', 'Get Garmin training readiness for a date.', { date }, ({ date }) => read(`/metrics-service/metrics/trainingreadiness/${date}`));
  tool('get_training_status', 'Get Garmin aggregated training status for a date.', { date }, ({ date }) => read(`/metrics-service/metrics/trainingstatus/aggregated/${date}`));
  tool('get_sleep_data', 'Get full sleep data for a date, including detailed time series. Prefer get_sleep_summary for a compact result.', { date }, ({ date }) => sleep(date));
  tool('get_sleep_summary', 'Get compact sleep metrics for a date. Missing measurements remain omitted.', { date }, async ({ date }) => {
    const data = record(await sleep(date));
    const daily = optionalRecord(data.dailySleepDTO);
    return {
      date,
      ...pick(daily, ['sleepTimeSeconds', 'napTimeSeconds', 'sleepStartTimestampGMT', 'sleepEndTimestampGMT', 'deepSleepSeconds', 'lightSleepSeconds', 'remSleepSeconds', 'awakeSleepSeconds', 'awakeCount', 'avgSleepStress']),
      sleepScore: pick(optionalRecord(optionalRecord(daily.sleepScores).overall), ['value', 'qualifierKey']),
      ...pick(data, ['restingHeartRate', 'avgOvernightHrv', 'restlessMomentsCount', 'wellnessSpO2SleepSummaryDTO']),
    };
  });
  tool('get_heart_rates_summary', 'Get compact daily heart-rate metrics in beats per minute.', { date }, async ({ date }) => {
    const data = record(await read(`/wellness-service/wellness/dailyHeartRate/${await displayName()}`, { date }));
    return pick(data, ['calendarDate', 'maxHeartRate', 'minHeartRate', 'restingHeartRate', 'lastSevenDaysAvgRestingHeartRate']);
  });
  tool('get_stress_summary', 'Get compact daily Garmin stress metrics.', { date }, async ({ date }) => pick(record(await read(`/wellness-service/wellness/dailyStress/${date}`)), ['calendarDate', 'maxStressLevel', 'avgStressLevel']));
  tool('get_hrv_data', 'Get HRV summary in milliseconds. Optionally include time-series readings.', { date, return_timeseries: z.boolean().default(false) }, async ({ date, return_timeseries }) => {
    const data = await read(`/hrv-service/hrv/${date}`);
    if (data === null) return null;
    const value = record(data);
    return return_timeseries ? value : pick(value, ['hrvSummary', 'sleepStartTimestampLocal', 'sleepEndTimestampLocal']);
  });
}
