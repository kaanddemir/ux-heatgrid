/** Lightweight capture summary (pure; shared by the content runtime and the service worker). */
import type { SessionCapture, SessionCaptureSummary } from './types';

export function summarizeCapture(c: SessionCapture): SessionCaptureSummary {
  const doc = c.scroll.roots.find((r) => r.kind === 'document');
  return {
    kind: 'capture',
    elapsedMs: Math.round(c.meta.elapsedMs),
    activeMs: Math.round(c.meta.activeMs),
    pointerSamples: c.pointer.count,
    clicks: c.clicks.filter((x) => x.kind === 'pointer').length + c.clicksDropped,
    activations: c.clicks.filter((x) => x.kind === 'activation').length,
    pages: 1,
    deepestScroll: doc ? Math.round(doc.deepestFraction * 1000) / 1000 : 0,
    controlsReached: c.elements.filter((e) => e.exposure.reached).length,
    controlsInteracted: c.elements.filter((e) => e.hasActiveInteraction).length,
    regionsInteracted: c.regions.filter((r) => r.interactedElements > 0 || r.clicks > 0).length,
    limitations: [...c.limitations],
  };
}
