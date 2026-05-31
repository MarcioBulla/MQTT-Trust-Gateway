export function adminStyles() {
  return `
    body { margin: 0; font-family: system-ui, sans-serif; background: #101318; color: #eef2f7; }
    main { max-width: 980px; margin: 0 auto; padding: 32px 20px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    nav { display: flex; gap: 8px; flex-wrap: wrap; }
    section { border: 1px solid #2d3440; border-radius: 8px; padding: 18px; margin: 16px 0; background: #171b22; }
    input, textarea, button { font: inherit; border-radius: 6px; border: 1px solid #3a4452; padding: 10px; }
    input, textarea { width: 100%; box-sizing: border-box; background: #0f1319; color: #eef2f7; margin: 6px 0 12px; }
    textarea { min-height: 160px; }
    button { background: #3f7cff; color: white; cursor: pointer; }
    button.secondary { background: #202734; }
    pre { overflow: auto; background: #0b0e13; padding: 12px; border-radius: 6px; }
    .row { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
    .passkey { display: flex; justify-content: space-between; gap: 12px; align-items: center; border-top: 1px solid #2d3440; padding: 12px 0; }
    .muted { color: #99a3b3; }
    #notice { min-height: 24px; margin: 12px 0; color: #f7c873; }
    #notice.ok { color: #7ee787; }
    #notice.error { color: #ff8a8a; }
  `;
}
