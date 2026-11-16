import { configureDemo, installDemoTransport } from './transport';
installDemoTransport();
configureDemo({
  notice: code => { void import('../state/store').then(m => m.toast(code)); },
  resolve: async (...args) => (await import('./resolver')).demoAnswer(...args),
  slotOffer: async (...args) => (await import('./resolver')).demoSlotOffer(...args),
});
void import('../bootstrap');
void import('./sample-slice').then((m) => m.showSampleSlice());
document.addEventListener('click', (event) => {
  const target = (event.target as Element | null)?.closest('button,[role="menuitem"]');
  const label = target?.textContent?.trim() ?? '';
  if (!target || !/^(Export\b|Send(?:\.\.\.|…)?$|Save Project\b)/i.test(label)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  void import('../state/store').then(({ toast }) => toast('Not available in demo mode', null, 3500, 'warning'));
}, true);
import './demo.css';
