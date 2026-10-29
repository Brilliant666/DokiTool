<script setup lang="ts">
import { useAttrs } from 'vue'
import { iconForClass } from '../utils/iconPaths'

defineOptions({ inheritAttrs: false })
const attrs = useAttrs()
// Resolve during render: Vue attrs update with the parent, but are not computed
// dependencies. This keeps theme, loading and status icons in sync with class.
</script>

<template>
  <i class="app-icon" v-bind="attrs" aria-hidden="true">
    <svg
      v-if="iconForClass(attrs.class)"
      :viewBox="iconForClass(attrs.class)!.viewBox"
      xmlns="http://www.w3.org/2000/svg"
      focusable="false"
      aria-hidden="true"
    >
      <path :d="iconForClass(attrs.class)!.path" />
    </svg>
  </i>
</template>

<style>
.app-icon {
  display: inline-block;
  flex-shrink: 0;
  font-style: normal;
  line-height: 1;
  vertical-align: -0.125em;
}

.app-icon > svg {
  display: block;
  width: auto;
  height: 1em;
  overflow: visible;
  fill: currentColor;
}

.app-icon.fa-spin {
  animation: app-icon-spin 2s linear infinite;
}

@keyframes app-icon-spin {
  to { transform: rotate(360deg); }
}
</style>
