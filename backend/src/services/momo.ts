import {createHmac, timingSafeEqual} from 'node:crypto';

export function momoConfig() {
  const partnerCode = process.env.MOMO_PARTNER_CODE;
  const accessKey = process.env.MOMO_ACCESS_KEY;
  const secretKey = process.env.MOMO_SECRET_KEY;
  const publicUrl = process.env.MOMO_PUBLIC_URL?.replace(/\/$/, '');
  if (!partnerCode || !accessKey || !secretKey || !publicUrl) return null;
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password)
    throw new Error('MOMO_PUBLIC_URL phải là URL HTTPS công khai.');
  return {partnerCode, accessKey, secretKey,
    ipnUrl: `${publicUrl}/api/payments/momo/ipn`,
    redirectUrl: `${publicUrl}/api/payments/momo/return`};
}

export function signMomo(fields: Record<string, string | number>, secret: string) {
  const raw = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('&');
  return createHmac('sha256', secret).update(raw).digest('hex');
}

export function verifyMomoIpn(body: Record<string, unknown>, config: NonNullable<ReturnType<typeof momoConfig>>) {
  const fields: Record<string, string | number> = {accessKey: config.accessKey};
  for (const key of ['amount', 'extraData', 'message', 'orderId', 'orderInfo', 'orderType', 'partnerCode', 'payType', 'requestId', 'responseTime', 'resultCode', 'transId']) {
    const value = body[key];
    if (typeof value !== 'string' && typeof value !== 'number') return false;
    fields[key] = value;
  }
  if (body.partnerCode !== config.partnerCode || typeof body.signature !== 'string' || !/^[a-f0-9]{64}$/i.test(body.signature)) return false;
  return timingSafeEqual(Buffer.from(signMomo(fields, config.secretKey), 'hex'), Buffer.from(body.signature, 'hex'));
}

export async function createMomoPayment(order: {orderId: string; requestId: string; amount: number; orderInfo: string}, config: NonNullable<ReturnType<typeof momoConfig>>) {
  const fields = {orderId: order.orderId, requestId: order.requestId, amount: order.amount,
    orderInfo: order.orderInfo, accessKey: config.accessKey, partnerCode: config.partnerCode,
    extraData: '', ipnUrl: config.ipnUrl, redirectUrl: config.redirectUrl, requestType: 'captureWallet'};
  const {accessKey: _accessKey, ...payload} = fields;
  const response = await fetch('https://test-payment.momo.vn/v2/gateway/api/create', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({...payload, autoCapture: true, lang: 'vi', signature: signMomo(fields, config.secretKey)}),
  });
  const result = await response.json() as Record<string, any>;
  if (!response.ok || result.resultCode !== 0) throw new Error('MoMo chưa tạo được giao dịch. Vui lòng thử lại hoặc liên hệ trung tâm.');
  if (result.orderId !== order.orderId || result.requestId !== order.requestId || result.amount !== order.amount || result.partnerCode !== config.partnerCode)
    throw new Error('Phản hồi MoMo không khớp giao dịch.');
  const url = new URL(result.payUrl);
  if (url.origin !== 'https://test-payment.momo.vn') throw new Error('URL thanh toán MoMo không hợp lệ.');
  return url.toString();
}
