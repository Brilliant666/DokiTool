import { computed, ref } from "vue";
import type { MediaItem, MediaSelection } from "../types/media";
import type { useVideoStore } from "../stores/video";
import { getDownloadTarget } from "../utils/mediaContract";
import { apiConfig } from "../services/apiConfig";

/** Selection is an explicit identity; resolving an item never resets the user's choice. */
export function useVideoSelection({
  videoStore,
}: {
  videoStore: ReturnType<typeof useVideoStore>;
}) {
  const selectedItemId = ref(""),
    sectionIndex = ref(0),
    selectedSet = ref(new Set<number>());
  const choices = ref(new Map<string, MediaSelection>());
  const list = computed(() =>
    (videoStore.resultData?.items || []).filter((item) =>
      ["video", "audio"].includes(item.type),
    ),
  );
  const collections = computed(() =>
    (videoStore.resultData?.groups || []).filter(
      (group) => group.kind !== "album",
    ),
  );
  const hasCollections = computed(() => collections.value.length > 0);
  const visibleList = computed(() => {
    const group = collections.value[sectionIndex.value];
    return group
      ? group.item_ids
          .map((id) => list.value.find((item) => item.id === id))
          .filter((item): item is MediaItem => !!item)
      : list.value;
  });
  const currentVideo = computed(
    () =>
      videoStore.resultData?.items.find(
        (item) => item.id === selectedItemId.value,
      ) || null,
  );
  const selectedIndex = computed(() =>
    visibleList.value.findIndex((item) => item.id === selectedItemId.value),
  );
  const currentSelection = computed(
    () => choices.value.get(selectedItemId.value) || null,
  );
  const currentTarget = computed(() =>
    currentVideo.value
      ? getDownloadTarget(currentVideo.value, currentSelection.value, {
          apiOrigin: apiConfig.baseUrl,
        })
      : null,
  );
  const currentVideoUrl = computed(() =>
    currentTarget.value?.kind === "file" ? currentTarget.value.url : "",
  );
  const selectedCount = computed(() => selectedSet.value.size);
  const total = computed(() => list.value.length),
    isMulti = computed(
      () =>
        list.value.length > 1 ||
        hasCollections.value ||
        (list.value.length > 0 &&
          list.value.length < (videoStore.resultData?.items.length || 0)),
    );
  function choose(choice: MediaSelection, itemId = selectedItemId.value) {
    choices.value = new Map(choices.value).set(itemId, { ...choice });
  }
  function resetDefault(itemId = selectedItemId.value) {
    const next = new Map(choices.value);
    next.delete(itemId);
    choices.value = next;
  }
  function selectIndex(index: number) {
    const item = visibleList.value[index];
    if (item) {
      selectedItemId.value = item.id;
      selectedSet.value = new Set();
    }
  }
  function setSection(index: number) {
    if (!collections.value[index]) return;
    sectionIndex.value = index;
    selectedSet.value = new Set();
    selectIndex(0);
  }
  function toggleSelect(index: number) {
    if (
      !visibleList.value[index] ||
      visibleList.value[index].state === "unavailable"
    )
      return;
    const next = new Set(selectedSet.value);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    selectedSet.value = next;
  }
  function selectAll() {
    selectedSet.value = new Set(
      visibleList.value.flatMap((item, index) =>
        item.state === "unavailable" ? [] : [index],
      ),
    );
  }
  function clearSelection() {
    selectedSet.value = new Set();
  }
  function getBatchVideos() {
    return selectedSet.value.size
      ? visibleList.value.filter((_, index) => selectedSet.value.has(index))
      : currentVideo.value
        ? [currentVideo.value]
        : [];
  }
  function syncResult() {
    const data = videoStore.resultData;
    choices.value = new Map();
    selectedSet.value = new Set();
    sectionIndex.value = 0;
    selectedItemId.value =
      data?.default_item_id ||
      (data?.items.length === 1 ? data.items[0].id : "");
    const group = collections.value.findIndex((group) =>
      group.item_ids.includes(selectedItemId.value),
    );
    if (group >= 0) sectionIndex.value = group;
  }
  return {
    selectedItemId,
    selectedIndex,
    sectionIndex,
    currentVideo,
    currentVideoUrl,
    currentTarget,
    currentSelection,
    list,
    visibleList,
    collections,
    hasCollections,
    total,
    isMulti,
    selectedSet,
    selectedCount,
    selectItem: (id: string) => {
      if (videoStore.resultData?.items.some((item) => item.id === id))
        selectedItemId.value = id;
    },
    choose,
    resetDefault,
    selectionFor: (id: string) => choices.value.get(id) || null,
    selectIndex,
    setSection,
    selectNext: () => selectIndex(selectedIndex.value + 1),
    selectPrev: () => selectIndex(selectedIndex.value - 1),
    toggleSelect,
    selectAll,
    clearSelection,
    getBatchVideos,
    syncResult,
    reset: syncResult,
  };
}
export type VideoSelection = ReturnType<typeof useVideoSelection>;
