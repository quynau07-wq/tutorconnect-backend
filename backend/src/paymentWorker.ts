import {db} from './config/firebase.js';
import {zaloConfig} from './services/zalopay.js';
import {refreshZaloPayment} from './domain/zalopayPayments.js';

export async function paymentTick() {
  const config = zaloConfig();
  if (!config) return;
  const pending = await db.collection('payment_orders').where('status', '==', 'pending').get();
  const orders = pending.docs.filter(doc => {
    const order = doc.data();
    return order.provider === 'zalopay' && order.appId === config.appId &&
      Date.now() - order.appTime < 24 * 3600000 &&
      Date.now() - (order.lastCheckedAtMs || order.appTime) >= 30000;
  }).sort((a, b) => (a.data().lastCheckedAtMs || 0) - (b.data().lastCheckedAtMs || 0)).slice(0, 50);
  for (const doc of orders) {
    await doc.ref.update({lastCheckedAtMs: Date.now()});
    try { await refreshZaloPayment(doc.id, config); }
    catch { console.warn(`Chưa đối soát được đơn ZaloPay ${doc.id}; sẽ thử lại.`); }
  }
}
export function startPaymentWorker() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await paymentTick(); }
    catch { console.error('Không thể đối soát ZaloPay; sẽ thử lại.'); }
    finally { running = false; }
  };
  tick();
  return setInterval(tick, 30000);
}
