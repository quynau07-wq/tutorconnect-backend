import {randomUUID} from 'node:crypto';
import {FieldValue} from 'firebase-admin/firestore';
import {db} from '../config/firebase.js';
import {createMomoPayment, momoConfig} from '../services/momo.js';

export async function momoCheckout(contractId: string, uid: string, config: NonNullable<ReturnType<typeof momoConfig>>) {
  const ref = db.collection('learning_contracts').doc(contractId);
  const order = await db.runTransaction(async tx => {
    const data = (await tx.get(ref)).data();
    if (!data || data.userId !== uid) throw new Error('Không tìm thấy hợp đồng.');
    if (!['WAIT_FIRST_PAYMENT', 'WAIT_BALANCE'].includes(data.status)) throw new Error('Hợp đồng không có khoản thanh toán đang chờ.');
    const stage = data.status === 'WAIT_FIRST_PAYMENT' ? 'FIRST' : 'BALANCE';
    const amount = stage === 'FIRST' ? data.firstAmount : data.remainingAmount;
    if (!Number.isSafeInteger(amount) || amount < 1000 || amount > 50000000) throw new Error('MoMo hỗ trợ số tiền từ 1.000 đến 50.000.000 đồng.');
    if (data.momoOrderId) {
      const previous = (await tx.get(db.collection('payment_orders').doc(data.momoOrderId))).data();
      if (previous?.stage === stage && previous.status !== 'failed') {
        if (previous.status === 'paid') throw new Error('Giao dịch đã nhận tiền, vui lòng cập nhật trạng thái hoặc liên hệ trung tâm.');
        return previous as {orderId: string; requestId: string; amount: number; orderInfo: string; url?: string};
      }
    }
    const orderId = `TC-${randomUUID()}`;
    const created = {orderId, requestId: orderId, contractId, userId: uid, stage, amount,
      orderInfo: `TutorConnect ${stage} ${contractId}`, provider: 'momo', environment: 'sandbox',
      status: 'pending', createdAt: FieldValue.serverTimestamp()};
    tx.create(db.collection('payment_orders').doc(orderId), created);
    tx.update(ref, {momoOrderId: orderId});
    return {...created, url: undefined};
  });
  const url = order.url || await createMomoPayment(order, config);
  // Never overwrite a status that an IPN may already have settled.
  if (!order.url) await db.collection('payment_orders').doc(order.orderId).update({url});
  return {orderId: order.orderId, url, sandbox: true};
}
