import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/projects' },
    { path: '/projects', name: 'projects', component: () => import('./pages/ProjectsPage.vue') },
    { path: '/quick', name: 'quick', component: () => import('./pages/QuickEditPage.vue') },
    { path: '/production', name: 'production', component: () => import('./pages/ProductionPage.vue') },
    { path: '/story', name: 'story', component: () => import('./pages/StoryPage.vue') },
    { path: '/shots', name: 'shots', component: () => import('./pages/ShotsPage.vue') },
    { path: '/shots/:id', name: 'shot', component: () => import('./pages/ShotPage.vue') },
    { path: '/assets', name: 'assets', component: () => import('./pages/AssetsPage.vue') },
    { path: '/timeline', name: 'timeline', component: () => import('./pages/TimelinePage.vue') },
    { path: '/settings', name: 'settings', component: () => import('./pages/SettingsPage.vue') },
  ],
});
