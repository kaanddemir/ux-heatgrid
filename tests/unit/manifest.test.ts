/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import manifest from '../../src/manifest.json';
import pkg from '../../package.json';

describe('manifest (source)', () => {
  it('is MV3 with the approved minimal permissions', () => {
    expect(manifest.manifest_version).toBe(3);
    expect([...manifest.permissions].sort()).toEqual(['activeTab', 'scripting', 'sidePanel', 'storage']);
    expect(manifest).not.toHaveProperty('host_permissions');
    expect(manifest).not.toHaveProperty('optional_host_permissions');
    expect(manifest).not.toHaveProperty('content_scripts');
    expect(manifest).not.toHaveProperty('web_accessible_resources');
    expect(manifest).not.toHaveProperty('externally_connectable');
  });

  it('points at the 2.0 build outputs', () => {
    expect(manifest.background).toEqual({ service_worker: 'background/sw.js', type: 'module' });
    expect(manifest.side_panel.default_path).toBe('sidepanel/index.html');
    expect(manifest.action).not.toHaveProperty('default_popup'); // the toolbar click must grant activeTab
  });

  it('gets its version from package.json at build time', () => {
    expect(manifest.version).toBe('0.0.0');
    expect(pkg.version).toMatch(/^2\.\d+\.\d+$/);
  });
});
