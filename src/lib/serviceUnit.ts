// Pure helpers for the systemd unit installer. Side-effecting I/O lives in
// src/bin/install-service.ts so this file stays trivially testable.

export interface RenderInput {
  template: string;
  installDir: string;
  nodeBinary: string;
}

export function renderUnit(input: RenderInput): string {
  return input.template
    .replace(/@@INSTALL_DIR@@/g, input.installDir)
    .replace(/@@NODE@@/g, input.nodeBinary);
}

export function unitInstallPath(homeDir: string): string {
  return `${homeDir}/.config/systemd/user/hark.service`;
}
