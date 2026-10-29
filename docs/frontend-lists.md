# Shared administrative lists

Use `frontend/components/DataList.vue` for administrative record tables and
`frontend/components/RowActions.vue` for row action menus. Devices, archived
devices, licenses, certificate history, live MQTT messages, observed retained
messages and audit events share this table foundation.

`DataList` forwards Vuetify data-table props, events and named slots. Its common
defaults provide comfortable density, hover feedback, pagination, page numbers,
page sizes, loading/empty text, fixed table layout and wrapping cell content.
`min-width` controls horizontal scrolling within the table on small screens;
it should fit the total configured column widths. Keep search/filter controls
outside the table and pass `search`, `custom-filter` and `loading` as needed.
Existing pagination and sorting bindings can be passed through unchanged.

```vue
<DataList :headers="headers" :items="records" :search="search" :loading="loading">
  <template #item.actions="{ item }">
    <RowActions :label="`Actions for ${item.name}`" :disabled="loading">
      <v-list-item title="Details" prepend-icon="mdi-information-outline" @click="showDetails(item)" />
    </RowActions>
  </template>
</DataList>
```

Use an empty title for the action column, make it non-sortable and reserve
sufficient width for its controls. `RowActions` provides the accessible ellipsis
button and compact dropdown; each page supplies its applicable operations and
retains responsibility for authorization and destructive-action confirmation.
These components do not change backend permissions or MQTT authorization.

Observed retained messages support topic/payload search, sorting, pagination,
details, topic copying and explicitly confirmed removal. Payloads render as
escaped text; long payloads scroll within their cells and the details dialog.
