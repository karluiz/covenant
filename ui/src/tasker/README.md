# Tasker Sidebar Implementation

## Overview
I've successfully implemented a **Tasker** sidebar for Covenant - a Microsoft To Do-style todo/task management system that works cross-project and cross-tab. It's fully integrated into the app's sidebar system and accessible via a button in the titlebar or keyboard shortcut.

## Architecture

### Files Created

#### 1. **ui/src/tasker/types.ts**
Core TypeScript types and interfaces:
- `Task`: Main task entity with status, priority, due dates, time tracking, subtasks, tags, grouping
- `Project`: Container for tasks with metadata
- `TaskStatus`: "pending" | "active" | "done" | "cancelled"
- `TaskPriority`: "low" | "normal" | "high" | "urgent"
- `RecurrenceType`: For recurring tasks (not yet implemented in UI)
- `TaskFilterOptions`: Filtering interface

**Key Features**:
- Support for due dates with time
- Priority levels with visual indicators (emoji badges)
- Task grouping by project
- Workspace group association (sessionId/groupId)
- Time estimates and tracking (estimatedMinutes, spentMinutes)
- Subtasks support
- Tagging system
- Recurrence support for future expansion

#### 2. **ui/src/tasker/storage.ts**
localStorage-based persistence layer:
- `TaskStorage` class handles all CRUD operations
- Automatic versioning for migrations
- Methods:
  - Project management: `createProject()`, `getProject()`, `updateProject()`, `deleteProject()`, `archiveProject()`
  - Task management: `createTask()`, `getTask()`, `updateTask()`, `deleteTask()`
  - Querying: `getAllTasks()` with `TaskFilterOptions`
  - Import/export: `export()`, `import()`

**Storage Structure**:
```
localStorage["covenant.tasker.store"] = {
  projects: [
    {
      id: string,
      name: string,
      tasks: Task[],
      createdAt: number,
      updatedAt: number,
      archivedAt?: number
    }
  ],
  version: 1
}
```

#### 3. **ui/src/tasker/panel.ts**
React-like TaskerPanel component:
- Singleton right-sidebar panel (like TeammatePanel)
- Features:
  - **Filter bar**: All / Active / Pending / Done status filters
  - **Project collapse/expand**: Persistent expansion state in localStorage
  - **Task management**: 
    - Checkbox to mark complete
    - Quick-add buttons
    - Context menu (Edit, Priority, Due date, Delete)
  - **Visual indicators**:
    - Priority emoji badges (🔴🟠🟡🟢)
    - Overdue indicator on due dates
    - Task completion cross-through
    - Description indicator (📝)
  - **Stats footer**: Shows count of done/active/pending tasks

**Key Methods**:
- `render()`: Full panel render
- `setupEventListeners()`: Wire event handlers
- `showNewTaskDialog()`: Create task via prompt
- `showNewProjectDialog()`: Create project via prompt
- `showTaskMenu()`: Context menu for task actions

#### 4. **ui/src/tasker/styles.css**
Complete styling (7.6 KB):
- Sidebar layout with header, filters, projects, footer
- Project tree with collapse/expand toggle and count badges
- Task list with rows showing checkbox, priority, title, menu
- Task metadata display (due date, description icon, tags)
- Context menu styling
- Responsive tweaks for mobile
- Scrollbar styling matching Covenant theme

### Integration Points

#### 1. **ui/index.html**
Added:
- New `<aside id="tasker-panel" class="hidden"></aside>` element
- Titlebar button: `<button id="titlebar-tasker">📋</button>`

#### 2. **ui/src/main.ts**
Added:
- Import: `import { TaskerPanel } from "./tasker/panel";`
- Style import: `import "./tasker/styles.css";`
- Panel instantiation and wiring
- Close handler to prevent conflicts with other right-rail panels
- **Keyboard shortcut**: `⌘⌥K` (Command+Option+K) to toggle tasker

**Integration Details**:
```typescript
// Tasker sidebar — todo list / task management.
const taskerPanelHost = requireEl<HTMLElement>("tasker-panel");
const taskerPanel = new TaskerPanel(taskerPanelHost);
const taskerBtn = document.getElementById("titlebar-tasker");

// "Dumb" open/close helpers — they only manage Tasker's own DOM/body state.
// Exclusivity (closing competing panels) and the active highlight are owned by
// the RightRailController (see ui/src/titlebar/right-rail.ts), NOT here.
const openTaskerPanel = (): void => {
  document.body.classList.add("sidebar-view-tasker");
  taskerPanelHost.classList.remove("hidden");
  taskerPanel.render();
};
const closeTaskerPanel = (): void => {
  if (!document.body.classList.contains("sidebar-view-tasker")) return;
  document.body.classList.remove("sidebar-view-tasker");
  taskerPanelHost.classList.add("hidden");
  taskerPanel.close();
};

// The titlebar button and the ⌘⌥K shortcut both route through the controller:
//   taskerBtn.addEventListener("click", () => rail.toggle("tasker"));
// The controller closes whatever else is open and toggles the active highlight.
```

## How to Use

### UI Interactions

1. **Open Tasker**:
   - Click the 📋 button in the titlebar (top-right area, next to Teammate)
   - Press `⌘⌥K` (macOS) or `Ctrl+Alt+K` (Windows/Linux)

2. **Filter Tasks**:
   - Click filter buttons: All / Active / Pending / Done
   - Filters persist while panel is open

3. **Expand/Collapse Projects**:
   - Click project header to toggle visibility
   - Expansion state persists in localStorage

4. **Create Tasks**:
   - Click "➕" button in header → type task title
   - Or click "+ Add task" inside a project
   - Default priority is "normal", status is "pending"

5. **Create Projects**:
   - Click "📁" button in header → type project name
   - Tasks live inside projects (Inbox project created by default)

6. **Manage Tasks**:
   - **Check off**: Click the checkbox (○ → ✓) to mark complete
   - **Edit**: Right-click (⋯) menu → "Edit" to rename
   - **Set Priority**: Right-click → "Priority" → type (low/normal/high/urgent)
   - **Set Due Date**: Right-click → "Due date" → type YYYY-MM-DD format
   - **Delete**: Right-click → "Delete"

### Data Persistence

All data is stored in `localStorage["covenant.tasker.store"]`:
- **Automatic**: Saves after every change
- **Portable**: Can be exported/imported via the storage API (future UI)
- **Cross-tab**: Works across all terminal tabs within the same workspace
- **Survives reload**: Data persists across app restarts

### Key Keyboard Shortcut

- **⌘⌥K** (macOS) or **Ctrl+Alt+K** (Windows/Linux): Toggle Tasker sidebar

## Design Decisions

### Why localStorage Over Backend?
- **Speed**: Instant writes, no server round-trip
- **Offline**: Works without network
- **Privacy**: Tasks stay on user's device
- **Simplicity**: No DB migration/schema management needed
- Future: Easy to sync to backend if desired

### Why Right Sidebar?
- Matches existing sidebar layout (Teammate, Activity, Project Notes)
- Natural placement for always-visible reference panel
- Can be toggled without disrupting terminal workspace
- Horizontal scrolling handled automatically

### Status Types
Four statuses provide workflow clarity:
- **pending**: Default - not started
- **active**: User is working on it
- **done**: Completed
- **cancelled**: Abandoned (kept for audit trail)

### Priority System
Emoji-based priorities are instantly visible:
- 🔴 **urgent** - Red, critical
- 🟠 **high** - Orange, important
- 🟡 **normal** - Yellow, standard
- 🟢 **low** - Green, backlog

## Future Enhancements

### Ready to Add:
1. **Subtasks UI**: Checkbox list inside each task
2. **Time Tracking**: Display + edit spentMinutes
3. **Tags**: Click to filter, colored pills
4. **Recurrence**: Auto-create due dates
5. **Notifications**: Overdue alerts
6. **Export**: JSON download, calendar integration
7. **Sync**: iCloud/cloud backend connection
8. **Drag & drop**: Reorder tasks/projects
9. **Search**: Filter by text query
10. **Session Binding**: "Run this task in this terminal"

### Data Fields Already Defined But Unused:
- `subtasks: SubTask[]`
- `estimatedMinutes`, `spentMinutes`
- `tags: string[]`
- `recurrence`, `recurrenceEndDate`
- `groupId`, `sessionId` (for future tab context)

## Testing & Validation

✅ **Build Status**: Compiles without errors  
✅ **TypeScript**: Full type safety  
✅ **Integration**: Wired into titlebar and keyboard shortcuts  
✅ **Storage**: localStorage API working  
✅ **UI**: Renders and interactive

## Files Modified

1. `ui/index.html` - Added tasker panel element & titlebar button
2. `ui/src/main.ts` - Imported TaskerPanel, added panel wiring, keyboard shortcut
3. `ui/src/main.ts` - Added tasker styles import

## Files Created

1. `ui/src/tasker/types.ts` (1.6 KB)
2. `ui/src/tasker/storage.ts` (6 KB)
3. `ui/src/tasker/panel.ts` (13.8 KB)
4. `ui/src/tasker/styles.css` (7.6 KB)

## Total Size

- **Source code**: ~29 KB
- **Minified + gzipped**: ~4-6 KB (estimated, bundled with main app)
- **localStorage overhead**: ~1-5 KB per 100 tasks (typical JSON)

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                  Covenant Terminal                      │
├─────────────────────────────────────────────────────────┤
│  Titlebar                                               │
│  [← Other buttons] [📋 Tasker] [→ Fold Right Sidebar]  │
├──────────────────────┬──────────────────────────────────┤
│  Tabbar              │  Right Sidebar (ONE slot)        │
│  ┌─────────────────┐ │  ┌──────────────────────────────┐│
│  │ Tab 1           │ │  │ TASKER PANEL                 ││
│  │ Tab 2           │ │  ├──────────────────────────────┤│
│  └─────────────────┘ │  │ Tasker       [➕] [📁]       ││
│                      │  ├──────────────────────────────┤│
│  Workspace          │  │ All│Active│Pending│Done       ││
│  ┌─────────────────┐ │  ├──────────────────────────────┤│
│  │ Terminal Output │ │  │ ▼ Inbox               (5)    ││
│  │                 │ │  │   ✓ Buy milk                 ││
│  │ $ _             │ │  │   ○ 🔴 Fix bug       Today   ││
│  └─────────────────┘ │  │   ○ 🟡 Review PR    Thu     ││
│                      │  │   + Add task                  ││
│                      │  ├──────────────────────────────┤│
│                      │  │ 2 done · 1 active · 2 pending││
│                      │  └──────────────────────────────┘│
└──────────────────────┴──────────────────────────────────┘

Right sidebar is shared between:
- Tasker (new!)
- Teammate Chat
- Activity Feed
- Project Notes

Only one panel visible at a time; switching closes the others.
```

---

**Status**: ✅ Ready to use! Press `⌘⌥K` to open the Tasker sidebar.
