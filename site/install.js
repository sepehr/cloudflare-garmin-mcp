export function installLinks(value) {
  if (value.length > 2048 || /[\s\\]/.test(value)) throw new Error('Invalid MCP URL.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password
    || url.search || url.hash || url.pathname !== '/mcp') throw new Error('Invalid MCP URL.');
  const server = { url: url.href };
  const vscode = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'garmin', type: 'http', ...server }))}`;
  return {
    endpoint: url.href,
    vscode: `https://vscode.dev/redirect?url=${encodeURIComponent(vscode)}`,
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=garmin&config=${encodeURIComponent(btoa(JSON.stringify(server)))}`,
  };
}

if (typeof document !== 'undefined') {
  const form = document.getElementById('install-form');
  const result = document.getElementById('result');
  const error = document.getElementById('error');
  const endpoint = document.getElementById('endpoint');
  const clearLinks = () => {
    result.hidden = true;
    for (const id of ['vscode', 'cursor']) document.getElementById(id).removeAttribute('href');
  };
  endpoint.addEventListener('input', () => { clearLinks(); error.textContent = ''; });
  form.addEventListener('submit', event => {
    event.preventDefault();
    clearLinks();
    try {
      const links = installLinks(endpoint.value.trim());
      document.getElementById('configured-url').textContent = links.endpoint;
      for (const id of ['vscode', 'cursor']) document.getElementById(id).href = links[id];
      error.textContent = '';
      result.hidden = false;
    } catch {
      error.textContent = 'Use an HTTPS URL ending in /mcp, with no credentials, query, or fragment.';
    }
  });
}
