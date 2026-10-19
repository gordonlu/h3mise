// Map classic page links (ProductionIssue.to / NextAction.to) to Studio
// targets. The server keeps returning classic paths; Studio translates them
// locally so classic pages stay usable.

import type { CanvasLane } from '@h3mise/shared';
import type { BottomDockTab, LeftDockTab } from '../stores/studioUi';

export interface StudioTarget {
  node?: string;
  lane?: CanvasLane;
  dock?: LeftDockTab;
  bottom?: BottomDockTab;
  tab?: string;
}

const SECTION_BY_CATEGORY: Record<string, string> = {
  assets: 'references',
  review: 'takes',
  continuity: 'takes',
  generation: 'preflight',
  story: 'design',
};

/** Classic path → Studio target. Returns null for pages that must stay classic (settings). */
export function toStudioLink(to: string, storyId: string | null, category?: string): StudioTarget | null {
  const [pathPart = '', queryPart] = to.split('?');
  const path = pathPart.replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(queryPart ?? '');

  if (path === '/story') return storyId ? { node: `story:${storyId}` } : { lane: 'beats' };
  if (path === '/storyboard') return { lane: 'storyboard' };
  if (path === '/shots') return { lane: 'shots' };

  const shot = path.match(/^\/shots\/([^/]+)/);
  if (shot?.[1]) {
    const target: StudioTarget = { node: `shot:${decodeURIComponent(shot[1])}` };
    const categorySection = category ? SECTION_BY_CATEGORY[category] : undefined;
    const tab = params.get('tab') ?? categorySection;
    if (tab) target.tab = tab;
    return target;
  }

  if (path === '/assets') return { dock: 'assets' };
  if (path === '/timeline' || path === '/quick') return { bottom: 'timeline' };
  if (path === '/production') return { bottom: 'problems' };
  return null;
}

/** Studio target → /studio URL. */
export function studioUrl(target: StudioTarget): string {
  const params = new URLSearchParams();
  if (target.node) params.set('node', target.node);
  if (target.lane) params.set('lane', target.lane);
  if (target.dock) params.set('dock', target.dock);
  if (target.bottom) params.set('bottom', target.bottom);
  if (target.tab) params.set('tab', target.tab);
  const query = params.toString();
  return query ? `/studio?${query}` : '/studio';
}

/** Classic page path → Studio path for links that do not know the storyId yet. */
export function toStudioPath(to: string): string {
  const target = toStudioLink(to, null);
  return target ? studioUrl(target) : to;
}
