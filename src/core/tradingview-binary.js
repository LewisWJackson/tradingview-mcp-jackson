/**
 * TradingView executable discovery.
 *
 * Keeps platform-specific binary discovery out of health.js so launch logic
 * remains small and changes are easy to review or upstream as a PR.
 */
import { existsSync } from 'fs';
import { execFileSync, execSync } from 'child_process';

function firstExisting(paths, exists = existsSync) {
  for (const candidate of paths) {
    if (candidate && exists(candidate)) return candidate;
  }
  return null;
}

export function defaultTradingViewCandidates(platform = process.platform, env = process.env) {
  const map = {
    darwin: [
      '/Applications/TradingView.app/Contents/MacOS/TradingView',
      `${env.HOME}/Applications/TradingView.app/Contents/MacOS/TradingView`,
    ],
    win32: [
      `${env.LOCALAPPDATA}\\TradingView\\TradingView.exe`,
      `${env.PROGRAMFILES}\\TradingView\\TradingView.exe`,
      `${env['PROGRAMFILES(X86)']}\\TradingView\\TradingView.exe`,
    ],
    linux: [
      '/opt/TradingView/tradingview',
      '/opt/TradingView/TradingView',
      `${env.HOME}/.local/share/TradingView/TradingView`,
      '/usr/bin/tradingview',
      '/snap/tradingview/current/tradingview',
    ],
  };
  return map[platform] || map.linux;
}

export function discoverWindowsMsixTradingView({
  exists = existsSync,
  execFile = execFileSync,
} = {}) {
  const psScript = [
    "$pkg = Get-AppxPackage TradingView.Desktop | Sort-Object Version -Descending | Select-Object -First 1",
    "if ($pkg) {",
    "  $exe = Get-ChildItem -LiteralPath $pkg.InstallLocation -Filter TradingView.exe -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName",
    "  if ($exe) { [Console]::Out.Write($exe) }",
    "}",
  ].join('; ');

  try {
    const found = execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        psScript,
      ],
      {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      },
    ).trim();

    return found && exists(found) ? found : null;
  } catch {
    return null;
  }
}

export function discoverTradingViewBinary({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  exec = execSync,
  execFile = execFileSync,
} = {}) {
  const candidates = defaultTradingViewCandidates(platform, env);

  let found = firstExisting(candidates, exists);
  if (found) return { path: found, candidates, source: 'default-path' };

  try {
    const cmd = platform === 'win32' ? 'where TradingView.exe' : 'which tradingview';
    const commandPath = exec(cmd, { timeout: 3000 })
      .toString()
      .trim()
      .split(/\r?\n/)[0];

    if (commandPath && exists(commandPath)) {
      return { path: commandPath, candidates, source: 'path-command' };
    }
  } catch {
    // Continue with platform-specific discovery.
  }

  if (platform === 'win32') {
    found = discoverWindowsMsixTradingView({ exists, execFile });
    if (found) return { path: found, candidates, source: 'windows-msix' };
  }

  if (platform === 'darwin') {
    try {
      const appPath = exec(
        'mdfind "kMDItemFSName == TradingView.app" | head -1',
        { timeout: 5000 },
      ).toString().trim();

      const candidate = appPath
        ? `${appPath}/Contents/MacOS/TradingView`
        : null;

      if (candidate && exists(candidate)) {
        return { path: candidate, candidates, source: 'spotlight' };
      }
    } catch {
      // No result.
    }
  }

  return { path: null, candidates, source: null };
}
