import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../config/firebase.js';
import {createHash} from 'node:crypto';

// Called only by a payment provider adapter after signature verification.
export async function settleContractPayment(
  orderId: string,
  amount: number,
  providerTransactionId: string,
) {
  if (!providerTransactionId || providerTransactionId.length > 200) throw new Error('Mã giao dịch không hợp lệ.');
  const orderRef = db.collection('payment_orders').doc(orderId);
  await db.runTransaction(async tx => {
    const order = (await tx.get(orderRef)).data();
    if (
      !order ||
      amount !== order.amount ||
      !Number.isSafeInteger(amount) ||
      amount <= 0
    )
      throw new Error('Giao dịch hoặc số tiền không hợp lệ.');
    if (order.status === 'paid') {
      if (order.providerTransactionId !== providerTransactionId)
        throw new Error('Mã giao dịch không khớp.');
      return;
    }
    const ref = db.collection('learning_contracts').doc(order.contractId);
    const paymentRef = db
      .collection('payments')
      .doc(`${order.contractId}_${order.stage}`);
    const transactionRef = db.collection('gateway_transactions').doc(createHash('sha256').update(`${order.provider}:${providerTransactionId}`).digest('hex'));
    const [contract, payment, transaction] = await Promise.all([
      tx.get(ref),
      tx.get(paymentRef),
      tx.get(transactionRef),
    ]);
    if (transaction.exists) throw new Error('Giao dịch đã được ghi nhận cho đơn khác.');
    const data = contract.data();
    if (!data) throw new Error('Không tìm thấy hợp đồng.');
    const first = order.stage === 'FIRST';
    if (
      !['FIRST', 'BALANCE'].includes(order.stage) ||
      amount !== (first ? data.firstAmount : data.remainingAmount)
    )
      throw new Error('Số tiền không khớp hợp đồng.');
    // Record a late/duplicate successful transfer for reconciliation, never activate twice.
    const needsReview =
      payment.exists ||
      data.status !== (first ? 'WAIT_FIRST_PAYMENT' : 'WAIT_BALANCE');
    tx.create(transactionRef, {orderId, amount});
    tx.update(orderRef, {
      status: 'paid',
      providerTransactionId,
      needsReview,
      paidAt: FieldValue.serverTimestamp(),
    });
    if (needsReview) {
      tx.create(db.collection('payment_reconciliation').doc(orderId), {
        orderId,
        contractId: ref.id,
        amount,
        providerTransactionId,
        reason: 'DUPLICATE_OR_STATE_CHANGED',
        createdAt: FieldValue.serverTimestamp(),
      });
      return;
    }
    tx.create(paymentRef, {
      contractId: ref.id,
      userId: data.userId,
      stage: order.stage,
      amount,
      provider: order.provider,
      providerTransactionId,
      recipient: 'CENTER',
      status: 'paid',
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(ref, {
      status: first ? 'FIRST_SCHEDULED' : 'ACTIVE',
      [first ? 'firstPaidAt' : 'balancePaidAt']: FieldValue.serverTimestamp(),
    });
  });
}
