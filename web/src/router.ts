import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/studio' },
    { path: '/projects', name: 'projects', component: () => import('./pages/ProjectsPage.vue') },
    { path: '/quick', name: 'quick', component: () => import('./pages/QuickEditPage.vue') },
    { path: '/production', name: 'production', component: () => import('./pages/ProductionPage.vue') },
    { path: '/story', name: 'story', component: () => import('./pages/StoryPage.vue') },
    { path: '/storyboard', name: 'storyboard', component: () => import('./pages/StoryboardPage.vue') },
    { path: '/shots', name: 'shots', component: () => import('./pages/ShotsPage.vue') },
    { path: '/shots/:id', name: 'shot', component: () => import('./pages/ShotPage.vue') },
    { path: '/studio', name: 'studio', component: () => import('./pages/StudioPage.vue') },
    { path: '/studio/series', name: 'studio-series', component: () => import('./pages/SeriesOverviewPage.vue') },
    { path: '/assets', name: 'assets', component: () => import('./pages/AssetsPage.vue') },
    { path: '/assets/:id/breakdown', name: 'reference-breakdown', component: () => import('./pages/ReferenceBreakdownPage.vue') },
    { path: '/timeline', name: 'timeline', component: () => import('./pages/TimelinePage.vue') },
    { path: '/settings', name: 'settings', component: () => import('./pages/SettingsPage.vue') },
  ],
});
