import {createHash} from 'node:crypto';
import {FieldValue} from 'firebase-admin/firestore';
import {db} from '../config/firebase.js';
import {settleContractPayment} from './contractPayments.js';
import {createZaloPayment, queryZaloPayment, validZaloTransaction, zaloOrderId, type ZaloConfig, type ZaloOrder} from '../services/zalopay.js';

// Query results come directly from ZaloPay over HTTPS using a signed request.
// A redirect or a client-supplied status is never used to credit a payment.
export async function refreshZaloPayment(orderId: string, config: ZaloConfig) {
  const ref = db.collection('payment_orders').doc(orderId);
  const order = (await ref.get()).data();
  if (!order || order.provider !== 'zalopay' || order.environment !== 'sandbox' || order.appId !== config.appId)
    throw new Error('Đơn thanh toán không khớp cấu hình ZaloPay.');
  if (order.status !== 'pending') return order;
  const result = await queryZaloPayment(orderId, config);
  if (result.return_code === 1) {
    if (result.amount !== order.amount || !validZaloTransaction(result.zp_trans_id)) throw new Error('Kết quả ZaloPay không khớp giao dịch.');
    await settleContractPayment(orderId, result.amount, String(result.zp_trans_id));
  } else if (result.return_code === 2 && result.sub_return_code === -54) {
    // Only confirmed expiry permits a replacement. Auth/network errors do not.
    await db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (current?.status === 'pending') tx.update(ref, {status: 'failed', failureReason: 'EXPIRED'});
    });
  } else if (result.return_code === 2 && result.sub_return_code === -101 && !order.url && Date.now() - order.appTime < 900000) {
    // A create request may have failed before reaching the provider. Retry the same ID.
    return order;
  } else if (result.return_code !== 3 && !(result.return_code === 2 && result.sub_return_code === -63)) {
    throw new Error('Chưa xác minh được trạng thái ZaloPay. Vui lòng thử lại sau.');
  }
  return (await ref.get()).data()!;
}

export async function zaloCheckout(contractId: string, uid: string, config: ZaloConfig) {
  const ref = db.collection('learning_contracts').doc(contractId);
  const initial = (await ref.get()).data();
  if (!initial || initial.userId !== uid) throw new Error('Không tìm thấy hợp đồng.');
  // Refresh before deciding whether an existing order can be replaced.
  if (initial.zaloOrderId) await refreshZaloPayment(initial.zaloOrderId, config);
  const order = await db.runTransaction(async tx => {
    const data = (await tx.get(ref)).data();
    if (!data || data.userId !== uid) throw new Error('Không tìm thấy hợp đồng.');
    if (!['WAIT_FIRST_PAYMENT', 'WAIT_BALANCE'].includes(data.status)) throw new Error('Hợp đồng không có khoản thanh toán đang chờ.');
    if (data.status === 'WAIT_FIRST_PAYMENT' && data.reservationExpiresAtMs && data.reservationExpiresAtMs <= Date.now())
      throw new Error('Đã hết thời gian giữ lịch. Vui lòng đăng ký gói học mới.');
    const stage = data.status === 'WAIT_FIRST_PAYMENT' ? 'FIRST' : 'BALANCE';
    const amount = stage === 'FIRST' ? data.firstAmount : data.remainingAmount;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Số tiền thanh toán không hợp lệ.');
    if (data.zaloOrderId) {
      const previous = (await tx.get(db.collection('payment_orders').doc(data.zaloOrderId))).data();
      if (previous?.stage === stage && previous.status !== 'failed') {
        if (previous.status === 'paid') throw new Error('Đã nhận tiền; vui lòng cập nhật trạng thái hoặc liên hệ trung tâm.');
        return previous as ZaloOrder & {url?: string};
      }
    }
    const appTime = Date.now();
    const orderId = zaloOrderId(appTime);
    const created = {orderId, contractId, userId: uid, stage, amount, appTime, appId: config.appId,
      appUser: createHash('sha256').update(uid).digest('hex').slice(0, 40),
      embedData: JSON.stringify({redirecturl: config.redirectUrl, preferred_payment_method: ['zalopay_wallet']}),
      callbackUrl: config.callbackUrl, description: `TutorConnect - ${stage === 'FIRST' ? 'Buoi dau' : 'Hoc phi con lai'}`,
      provider: 'zalopay', environment: 'sandbox', status: 'pending', createdAt: FieldValue.serverTimestamp()};
    tx.create(db.collection('payment_orders').doc(orderId), created);
    tx.update(ref, {zaloOrderId: orderId});
    return {...created, url: undefined};
  });
  const url = order.url || await createZaloPayment(order, config);
  if (!order.url) await db.collection('payment_orders').doc(order.orderId).update({url});
  return {orderId: order.orderId, url, provider: 'zalopay', sandbox: true};
}
