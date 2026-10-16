<script setup lang="ts">
// Thin route wrapper: the Storyboard editor lives in StoryboardPageEditor so it
// can be reused (e.g. a Studio inspector) without the route.
import StoryboardPageEditor from '../components/storyboard/StoryboardPageEditor.vue';
</script>

<template>
  <StoryboardPageEditor />
</template>
