# Thanh toán ảo qua ZaloPay sandbox

Demo bằng điện thoại ngoài đường, không cần laptop/USB: xem [DEPLOY_RENDER.md](DEPLOY_RENDER.md).

Luồng mặc định đã chuyển sang ZaloPay sandbox. Backend chỉ gọi `https://sb-openapi.zalopay.vn/v2/create` và `/v2/query`. Không kết nối cổng production.

## 1. Chạy ngay với bộ demo đã gửi

Không cần build project Android demo cũ hay cài SDK `.aar`. TutorConnect mở trang thanh toán sandbox, backend dùng API truy vấn để xác nhận tiền.

Đã lấy App ID `2553` và `MAC_KEY` (Key 1) từ `Constant/AppInfo.java` trong ZIP vào `backend/.env`. Không ghi giá trị khóa vào tài liệu hoặc frontend. Cấu hình hiện tại:

```dotenv
PAYMENT_PROVIDER=zalopay
ZALOPAY_VERIFY_MODE=query
ZALOPAY_APP_ID=2553
ZALOPAY_KEY1=<MAC_KEY đã được điền trong .env>
ZALOPAY_KEY2=
ZALOPAY_PUBLIC_URL=
```

Trong chế độ `query`, Key 2 và tunnel HTTPS không bắt buộc. Backend không gửi `callback_url` khi tạo đơn và từ chối callback đến endpoint của TutorConnect; chỉ kết quả truy vấn trực tiếp ZaloPay được dùng để ghi nhận thanh toán. ZaloPay có thể vẫn gửi callback tới URL mặc định của merchant demo, nhưng TutorConnect không phụ thuộc callback đó.

Ngày 25/09/2026 đã thử trực tiếp: tạo đơn 1.000đ nhận `return_code=1`, URL thuộc `https://qcgateway.zalopay.vn`, truy vấn nhận `return_code=3` (đang chờ thanh toán). Chưa xác nhận thanh toán trong ví. Các đơn kiểm tra kết nối không gắn với hợp đồng và không ghi tiền vào Firestore.

Bộ khóa mẫu dùng cho demo sandbox chung, không phải thông tin merchant riêng của TutorConnect. Không dùng cho tiền thật.

## 2. Tùy chọn: dùng merchant riêng và callback

Cài ví sandbox trên điện thoại chưa cung cấp khóa tích hợp riêng. Nếu cần quản lý merchant riêng và nhận callback, hãy xin bộ khóa riêng như sau.

Theo [quy trình chính thức](https://docs.zalopay.vn/vi/docs/developer-tools/integration-guide/), cung cấp số điện thoại và email cho bộ phận hỗ trợ/BD ZaloPay để được tạo tài khoản sandbox và cấp App ID cùng các khóa. Có thể liên hệ qua mục hỗ trợ trên trang tài liệu; thông tin liên hệ được công bố: `hotro@zalopay.vn`, hotline `1900 545 436`.

Nội dung đề nghị có thể dùng:

> Tôi đang làm đồ án TutorConnect, cần tích hợp thanh toán thử nghiệm qua ZaloPay Gateway. Nhờ hỗ trợ cấp tài khoản merchant sandbox, App ID, Key 1 và Key 2. Tôi chỉ sử dụng môi trường sandbox, không thu tiền thật. Email: …; số điện thoại: …

Sau khi được cấp tài khoản, đăng nhập [Merchant Sandbox](https://sbmc.zalopay.vn/) và xem ứng dụng tích hợp được cấp. Không dùng khóa production hoặc lấy khóa từ tài khoản ví trên điện thoại. Không đưa Key 1/Key 2 vào chat, source frontend hay Git.

Để chuyển sang chế độ callback, điền đầy đủ:

```dotenv
PAYMENT_PROVIDER=zalopay
ZALOPAY_VERIFY_MODE=callback
ZALOPAY_APP_ID=
ZALOPAY_KEY1=
ZALOPAY_KEY2=
ZALOPAY_PUBLIC_URL=https://your-public-backend-host
```

`ZALOPAY_PUBLIC_URL` là địa chỉ HTTPS của **backend**, không phải admin-web. Khi chạy local, dùng tunnel HTTPS trỏ về cổng 3000 (ví dụ công cụ tunnel đã cài của bạn). Tunnel phải cho POST callback đi qua trực tiếp, không có màn hình đăng nhập hay xác nhận.

- Callback: `https://your-public-backend-host/api/payments/zalopay/callback`
- Redirect: `https://your-public-backend-host/api/payments/zalopay/return`

Ở chế độ callback, backend gửi hai địa chỉ này khi tạo đơn. Nếu Merchant Portal yêu cầu khai báo/cho phép địa chỉ thì đăng ký đúng hai URL trên.

## 3. Khởi động backend và nối máy Android thật

Khởi động lại backend sau khi đổi `.env` (dừng tiến trình backend cũ trước nếu đang chạy):

```powershell
cd backend
npm run dev
```

Code mobile hiện dùng `http://127.0.0.1:3000` để làm việc qua USB. Bật USB debugging, kết nối máy tính rồi chạy ở thư mục dự án:

```powershell
adb devices
adb reverse tcp:3000 tcp:3000
adb reverse tcp:8081 tcp:8081
npm start
```

Nếu cần cài/chạy lại TutorConnect, mở terminal khác và chạy `npm run android`. Sau khi rút/cắm USB có thể phải chạy lại `adb reverse`. Trong phiên tích hợp này đã thiết lập reverse cho điện thoại đang kết nối.

Muốn dùng Wi-Fi không dây: đổi `API_URL` trong `src/services/api.ts` sang IP LAN của máy tính hoặc HTTPS backend. Chỉ chế độ callback mới cần URL HTTPS công khai để nhận callback. Trong chế độ query không có URL công khai, trang quay về là `http://127.0.0.1:3000/api/payments/zalopay/return`, truy cập được từ điện thoại nhờ `adb reverse`. Có thể tự quay lại TutorConnect nếu trang quay về không mở được.

## 4. Thử thanh toán

1. Đăng nhập **ZaloPay sandbox** trên máy thật. Theo [hướng dẫn ví kiểm thử](https://docs.zalopay.vn/vi/docs/developer-tools/test-instructions/test-wallets/), mã xác minh thử nghiệm là `111111`; thiết lập mật khẩu và nạp số dư thử nghiệm theo hướng dẫn trên trang này.
2. Đăng nhập TutorConnect bằng tài khoản người học/phụ huynh. Đăng ký gói học thật trong hệ thống, mở **Gói học của tôi**.
3. Bấm thanh toán buổi đầu. App mở URL do ZaloPay sandbox trả về. Chọn mở ví sandbox nếu trang thanh toán cung cấp nút mở app và xác nhận trong ví.
4. Nếu trình duyệt không mở được ví sandbox trên cùng máy, mở URL thanh toán trên máy tính rồi dùng ví sandbox trên điện thoại quét QR. Không quét bằng ví production. Không tự đoán/thay scheme deeplink vì phụ thuộc phiên bản ví.
5. Quay lại TutorConnect. App kiểm tra kết quả mỗi 5 giây trong phiên thanh toán; có thể bấm **Cập nhật trạng thái** kể cả sau khi mở lại app.
6. Thanh toán thành công: hợp đồng chuyển `WAIT_FIRST_PAYMENT` → `FIRST_SCHEDULED`. Sau khi trung tâm xác nhận buổi đầu và người học đồng ý tiếp tục, thanh toán phần còn lại chuyển `WAIT_BALANCE` → `ACTIVE`.

Đóng trình duyệt hoặc quay về app không đồng nghĩa thanh toán thành công. Backend xác minh MAC callback bằng Key 2, hoặc truy vấn trực tiếp bằng Key 1, đối chiếu số tiền trước khi ghi nhận. Không có nút giả lập thành công bỏ qua ZaloPay.

## Xử lý gián đoạn

- Đơn đang chờ dùng lại cùng mã/URL, không tạo đơn khác chỉ vì bấm lại.
- Hết hạn được ZaloPay xác nhận bằng mã `-54`: cho tạo đơn mới. Đơn được tạo với thời hạn 15 phút.
- Thiếu tiền, mạng lỗi hoặc sai khóa không được coi là đã trả tiền hay tự động cho tạo đơn thay thế.
- Callback và kết quả truy vấn gửi lặp không ghi nhận tiền hai lần. Giao dịch đến sau khi hợp đồng bị hủy được đưa vào đối soát.
- Backend có worker kiểm tra các đơn chờ mới trong 24 giờ, chạy mỗi 30 giây và xử lý tối đa 50 đơn mỗi lượt. Đơn cũ hơn cần kiểm tra qua nút cập nhật hoặc trung tâm đối soát. Worker hoạt động khi backend đang chạy.
- Nếu tạo đơn bị timeout sau khi ZaloPay đã nhận nhưng trước khi lưu URL, hệ thống giữ mã đơn để đối soát; mã `-68` cần kiểm tra trên merchant portal, không sửa hợp đồng thành đã thanh toán.
- Luồng MoMo cũ chỉ bật lại khi đặt `PAYMENT_PROVIDER=momo`; mặc định hiện là `zalopay`.

## Kiểm tra

`npm test` trong `backend` chạy test mock HTTP/Firestore. Các test không thay thế một giao dịch thử trực tiếp với tài khoản merchant sandbox của bạn.

API tham khảo: [tạo đơn](https://docs.zalopay.vn/docs/specs/order-create/), [callback](https://docs.zalopay.vn/docs/developer-tools/knowledge-base/callback/), [truy vấn kết quả](https://docs.zalopay.vn/docs/specs/order-query/).
