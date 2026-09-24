# Demo trên điện thoại không cần laptop

## Trạng thái chuẩn bị

Repo đã có `render.yaml` để tạo Render Web Service và cấu hình app qua `npm run backend:url`. Chưa có dịch vụ online cho đến khi bạn triển khai bằng tài khoản Render của mình và nhận URL thật. Chưa build APK demo online khi chưa có URL.

## 1. Đưa mã nguồn lên repository riêng

Đăng nhập GitHub và tạo repository private. Đưa `render.yaml` ở thư mục gốc và thư mục `backend` vào repository, giữ nguyên cấu trúc. Có thể dùng gói `deployment/tutorconnect-render.zip` đã chuẩn bị, giải nén rồi upload nội dung vào repository. Không upload nguyên file ZIP vào GitHub để deploy.

Gói deploy chỉ chứa source, test và cấu hình build; không chứa `.env`, `service-account.json`, `node_modules` hay dữ liệu người dùng. Nếu upload thủ công, GitHub không áp dụng `.gitignore`, vì vậy không kéo toàn bộ thư mục làm việc lên web. `backend/package-lock.json` cần có để chạy `npm ci`.

## 2. Tạo dịch vụ trên Render

1. Đăng nhập https://dashboard.render.com/ bằng tài khoản của bạn.
2. Chọn **New → Blueprint**, kết nối repository vừa tạo, dùng file `render.yaml` ở gốc.
3. Blueprint chọn Free, backend Node, root directory `backend`, build `npm ci --include=dev && npm run build`, start `npm start`, health check `/health`.
4. Điền các biến được yêu cầu dưới đây. Không gửi khóa vào chat hoặc commit lên repository.

| Biến Render | Lấy giá trị từ đâu |
| --- | --- |
| `FIREBASE_PROJECT_ID` | `project_id` trong `backend/service-account.json` |
| `FIREBASE_CLIENT_EMAIL` | `client_email` trong cùng file |
| `FIREBASE_PRIVATE_KEY` | `private_key` trong cùng file; giữ nguyên BEGIN/END PRIVATE KEY, hỗ trợ xuống dòng thật hoặc `\n` |
| `ADMIN_EMAILS` | Danh sách email admin trong `backend/.env` |
| `SUPER_ADMIN_EMAILS` | Danh sách email quản trị cấp cao trong `backend/.env` |
| `ZALOPAY_APP_ID` | Giá trị trong `backend/.env` (demo hiện là `2553`) |
| `ZALOPAY_KEY1` | Giá trị đã chuẩn bị trong `backend/.env` |

`PAYMENT_PROVIDER=zalopay`, `ZALOPAY_VERIFY_MODE=query` và Node version đã được khai báo. Không đặt `FIREBASE_SERVICE_ACCOUNT_PATH` trỏ tới đường dẫn máy Windows. Không cần Key 2 hoặc tunnel trong chế độ query.

5. Chọn tạo/deploy Blueprint. Chờ dịch vụ báo **Live**.
6. Sao chép URL HTTPS do Render cấp. Tên có thể khác `tutorconnect-api`, không tự đoán URL.
7. Mở `https://<URL-thật>/health`, cần nhận `{"status":"ok","service":"tutorconnect-backend"}`.

Backend tự dùng `RENDER_EXTERNAL_URL` làm địa chỉ quay về sau thanh toán, nên không quay về localhost trên điện thoại. Nếu đã đặt `ZALOPAY_PUBLIC_URL` thủ công thì bỏ giá trị cũ hoặc thay bằng đúng URL online.

## 3. Cập nhật app và tạo APK chạy độc lập

Tại thư mục gốc TutorConnect, thay URL bên dưới bằng URL thật:

```powershell
npm run backend:url -- https://your-service.onrender.com
npm run demo:check
cd android
.\gradlew.bat assembleRelease
adb install -r app\build\outputs\apk\release\app-release.apk
```

Lệnh `backend:url` kiểm tra `/health` trước khi lưu URL vào `src/config/backend.ts`. URL chưa triển khai sẽ không được lưu. File này chỉ chứa địa chỉ công khai.

APK **release** chứa JS bundle, chạy được khi tắt Metro và rút USB. Repo hiện ký release bằng debug keystore để demo nội bộ; không phải cấu hình phát hành lên Play Store. Không dùng bản debug đang phụ thuộc Metro cho buổi demo ngoài đường.

Nếu dùng admin-web trên máy khác, đặt `VITE_API_URL` bằng URL online trong môi trường build của admin-web. Việc host trang admin là bước riêng; không cần để app người học truy cập API online.

## 4. Kiểm tra trước buổi demo

1. Rút USB, tắt Metro và backend trên laptop.
2. Bật 4G/5G trên điện thoại, mở URL `/health` để đánh thức dịch vụ Free trước khi demo.
3. Mở TutorConnect, đăng nhập và tải danh sách gia sư/gói học từ Firestore.
4. Tạo đơn ZaloPay sandbox, xác nhận trong ví sandbox, quay lại TutorConnect và bấm cập nhật trạng thái.
5. Kiểm tra hợp đồng chuyển đúng trạng thái. Có URL `/health` hoạt động mới xác nhận backend chạy; phải thử đăng nhập/tải dữ liệu/thanh toán để kiểm tra đầy đủ credentials.

Render Free ngủ sau 15 phút không có request; lần gọi tiếp theo có thể chờ khoảng một phút. App đang có timeout 20 giây, vì vậy hãy chờ `/health` trả thành công trên trình duyệt rồi mở app. Worker thanh toán/thông báo không chạy khi dịch vụ ngủ; khi thức lại, backend tiếp tục đối soát các đơn trong phạm vi hiện có. Nếu cần chạy nền liên tục, cân nhắc instance không ngủ phù hợp ngân sách. Dữ liệu vẫn lưu trên Firestore.

Tài liệu: [Express trên Render](https://render.com/docs/deploy-node-express-app), [Blueprint](https://render.com/docs/blueprint-spec), [giới hạn Free](https://render.com/docs/free).
