// a11y helpers (task-359): keyboard semantics for role=radiogroup answer controls.
//
// The one-tap answer options are separate <form><button> pairs (each submits its
// value), exposed to AT as a radiogroup. This action adds the APG radio-group
// keyboard contract on top: roving tabindex (one tab stop for the whole group)
// and Arrow-key movement between options. Activation stays the button's own
// click/submit, so behavior is unchanged for pointer users.
export function radioNav(node) {
  const radios = () => [...node.querySelectorAll('[role="radio"]:not(:disabled)')];

  function initTabs() {
    const rs = radios();
    if (!rs.length) return;
    const checked = rs.find((r) => r.getAttribute('aria-checked') === 'true') ?? rs[0];
    for (const r of rs) r.tabIndex = r === checked ? 0 : -1;
  }

  function onKeydown(e) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const rs = radios();
    const i = rs.indexOf(document.activeElement);
    if (i === -1) return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = rs[(i + dir + rs.length) % rs.length];
    for (const r of rs) r.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  }

  initTabs();
  node.addEventListener('keydown', onKeydown);
  return { destroy: () => node.removeEventListener('keydown', onKeydown) };
}
