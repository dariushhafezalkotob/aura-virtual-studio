import os from 'node:os';

export function getLocalIpAddress(): string {
  const interfaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        if (name.startsWith('en') || name.startsWith('eth') || alias.address.startsWith('192.168.')) {
          return alias.address;
        }
        candidates.push(alias.address);
      }
    }
  }
  return candidates[0] || '192.168.101.246';
}
