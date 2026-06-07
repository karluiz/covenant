# Tasker Panel Debugging Checklist

## Debug Steps

1. **Open DevTools** (F12 / Cmd+Option+I)

2. **Check if Panel Element Exists**
   ```javascript
   document.getElementById('tasker-panel')  // Should return the element
   ```

3. **Check if Panel is Visible**
   ```javascript
   const el = document.getElementById('tasker-panel');
   console.log({
     hidden: el.classList.contains('hidden'),
     display: window.getComputedStyle(el).display,
     visibility: window.getComputedStyle(el).visibility,
     gridColumn: window.getComputedStyle(el).gridColumn,
     gridRow: window.getComputedStyle(el).gridRow,
   });
   ```

4. **Check Body Classes**
   ```javascript
   console.log(document.body.className);  // Should include "sidebar-view-tasker"
   ```

5. **Inspect #layout Grid**
   ```javascript
   const layout = document.getElementById('layout');
   console.log({
     display: window.getComputedStyle(layout).display,
     gridTemplateColumns: window.getComputedStyle(layout).gridTemplateColumns,
     gridTemplateRows: window.getComputedStyle(layout).gridTemplateRows,
   });
   ```

6. **Check Content Rendering**
   ```javascript
   document.getElementById('tasker-panel').innerHTML  // Check if content is there
   ```

## Common Issues & Fixes

### Issue: Panel Not Showing
- Check `hidden` class is removed ✓
- Check `sidebar-view-tasker` class is added to body ✓
- Check `blocks-globally-collapsed` is NOT set ✓

### Issue: Panel Wrong Size
- Check grid-column is correct (should be 2 / 3)
- Check grid-row is correct (should be 2 / 3)
- Check var(--right-sidebar-w) is defined (should be 240px)

### Issue: Panel Invisible
- Check z-index (should be 1)
- Check overflow settings
- Check background color

### Issue: Content Not Showing
- Check panel.render() is being called
- Check innerHTML has content
- Check colors have enough contrast
