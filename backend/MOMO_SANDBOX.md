# Thanh toán thử nghiệm MoMo

Luồng mặc định hiện dùng ZaloPay: xem [ZALOPAY_SANDBOX.md](ZALOPAY_SANDBOX.md). Chỉ dùng hướng dẫn MoMo này nếu đặt `PAYMENT_PROVIDER=momo` trong `.env`.

Tích hợp chỉ gọi `https://test-payment.momo.vn`; không sử dụng tiền thật.

## Cấu hình

1. Lấy bộ thông tin tích hợp **test** của tài khoản doanh nghiệp MoMo: `partnerCode`, `accessKey`, `secretKey`.
2. Điền vào `backend/.env` (không đưa khóa vào Firebase frontend, admin-web hoặc ứng dụng):

   ```dotenv
   MOMO_PARTNER_CODE=your-test-partner-code
   MOMO_ACCESS_KEY=your-test-access-key
   MOMO_SECRET_KEY=your-test-secret-key
   MOMO_PUBLIC_URL=https://your-public-backend-host
   ```

3. Backend cần URL HTTPS công khai. Khi chạy local cổng 3000, dùng tunnel HTTPS trỏ đến cổng này. URL phải chuyển tiếp cả GET và POST, không có trang yêu cầu đăng nhập/xác nhận trước khi truy cập. Thay `MOMO_PUBLIC_URL` khi địa chỉ tunnel thay đổi, sau đó khởi động lại backend bằng `npm run dev` trong thư mục `backend`.
4. Điện thoại phải truy cập được API: chỉnh `API_URL` trong `src/services/api.ts` sang IP LAN của máy chạy backend hoặc URL tunnel nếu cần. Android emulator dùng `10.0.2.2:3000` mặc định.
5. Cài **MoMo Test** và sử dụng tài khoản test theo tài liệu MoMo; không dùng ví production để thử giao dịch này.

## Luồng kiểm thử

- Tạo gói học bằng màn hình đăng ký gói học hiện tại → mở **Gói học của tôi** → thanh toán buổi đầu.
- Ứng dụng mở trang thanh toán MoMo sandbox. Backend tự tính số tiền từ hợp đồng.
- Sau khi trả về trang TutorConnect, quay lại ứng dụng. Trạng thái được tải lại khi app hoạt động; trong phiên thanh toán, app kiểm tra kết quả mỗi 5 giây. Có thể bấm **Cập nhật trạng thái**.
- Backend chỉ ghi nhận thành công sau IPN có chữ ký đúng, khớp đơn hàng và số tiền. Trang redirect không kích hoạt hợp đồng.
- Trung tâm xác nhận buổi đầu hoàn thành → người học đồng ý tiếp tục → thanh toán phần còn lại → hợp đồng chuyển sang `ACTIVE`.
- Hủy thanh toán trên MoMo: sau IPN thất bại, nút thanh toán sẽ tạo giao dịch mới. Bấm nhiều lần khi đang chờ sẽ dùng lại đơn và URL hiện có.
- Callback thành công gửi lặp chỉ ghi nhận một lần. Tiền đến sau khi hợp đồng bị hủy hoặc đã được thanh toán được đưa vào `payment_reconciliation` để trung tâm đối soát.

## API

- `POST /api/contracts/:id/checkout`: Firebase ID token của chủ hợp đồng; trả `{orderId, url, sandbox: true}`.
- `GET /api/payments/:id`: Firebase ID token của chủ đơn; trả trạng thái `pending`, `paid`, `failed` và `needsReview`.
- `POST /api/payments/momo/ipn`: MoMo gọi trực tiếp, xác thực bằng HMAC-SHA256; trả HTTP 204 sau khi xử lý.
- `GET /api/payments/momo/return`: trang hướng dẫn quay về app, không tin dữ liệu query để ghi nhận tiền.

Nếu IPN không đến, trạng thái giữ nguyên chờ; kiểm tra URL tunnel và cấu hình MoMo. Hiện chưa có tác vụ truy vấn MoMo tự động để bù IPN bị mất. Nếu request tạo giao dịch bị timeout, hệ thống giữ cùng mã đơn/request để tránh tạo giao dịch khác khi chưa biết kết quả; có thể cần đối soát trên MoMo nếu MoMo báo mã bị trùng. Không sửa trạng thái hợp đồng thủ công thành đã trả tiền để bỏ qua lỗi này.

## Tài liệu chính thức

- https://developers.momo.vn/v3/vi/docs/payment/api/wallet/onetime/
- https://developers.momo.vn/v3/docs/payment/api/result-handling/notification/
- https://developers.momo.vn/v3/docs/payment/api/result-handling/resultcode/

Kiểm thử tự động: `npm test` trong `backend`. Các test dùng mock Firestore và HTTP MoMo; giao dịch thực trên sandbox cần cấu hình và kiểm thử thủ công như trên.
