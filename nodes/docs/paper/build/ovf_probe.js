addEventListener('load', () => document.fonts.ready.then(() => {
  const out = [];
  const col = document.querySelector('main').clientWidth;
  const label = (el) => el.textContent.replace(/\s+/g, ' ').slice(0, 70);
  document.querySelectorAll('.katex-display, table, figure img, pre:not(#ovf)').forEach((el) => {
    const inner = el.matches('.katex-display') ? el.querySelector('.katex') : el;
    const over = Math.max(el.scrollWidth - el.clientWidth, inner.scrollWidth - col, inner.getBoundingClientRect().width - col);
    if (over > 1) out.push('WIDE ' + el.tagName + ' +' + Math.round(over) + 'px :: ' + label(el));
    const tag = el.querySelector('.tag');
    if (tag) {
      const t = tag.getBoundingClientRect();
      let right = -Infinity;
      el.querySelectorAll('.katex-html > .base').forEach((b) => { right = Math.max(right, b.getBoundingClientRect().right); });
      const gap = t.left - right;
      if (gap < 12) out.push('TAG gap=' + Math.round(gap) + 'px :: ' + label(el));
    }
  });
  document.getElementById('ovf').textContent = 'OVF-BEGIN col=' + col + '\n' + out.join('\n') + '\nOVF-END';
}));
