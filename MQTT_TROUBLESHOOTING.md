# 🔧 Hướng Dẫn Khắc Phục Lỗi Kết Nối MQTT

## ❌ NGUYÊN NHÂN CHÍNH:

### 1. **Thư viện Paho MQTT chưa load kịp**
- File HTML dùng `defer` nên script.js có thể chạy trước khi Paho load xong
- **Đã sửa**: Thêm kiểm tra và retry sau 1 giây

### 2. **Username/Password HiveMQ Cloud**
- HiveMQ Cloud là private broker, yêu cầu authentication
- **Đã sửa**: Username: "SmartHome", Password: "SmartHome01"

### 3. **SSL/TLS Certificate**
- HiveMQ Cloud yêu cầu kết nối WSS (WebSocket Secure)
- Port: 8884 (không phải 8083)

---

## ✅ CÁCH KIỂM TRA:

### Bước 1: Mở Console của trình duyệt
1. Nhấn **F12** hoặc **Cmd+Option+I** (Mac)
2. Chọn tab **Console**
3. Refresh trang (F5)

### Bước 2: Xem log kết nối MQTT
Tìm các dòng log:
```
✅ Thành công:
Đang kết nối MQTT: {host: "6ceea111b6144c71a57b21faa3553fc6.s1.eu.hivemq.cloud", ...}
MQTT Connected to 6ceea111b6144c71a57b21faa3553fc6.s1.eu.hivemq.cloud

❌ Thất bại:
MQTT Kết nối thất bại: {...}
Error code: X
Error message: Connection refused
```

---

## 🔍 CÁC LỖI THƯỜNG GẶP:

### Lỗi 1: "Connection refused: Not authorized"
**Nguyên nhân**: Username/Password sai

**Giải pháp**:
1. Kiểm tra HiveMQ Cloud Dashboard
2. Xác nhận username: `SmartHome`
3. Xác nhận password: `SmartHome01`
4. Nếu sai, sửa trong [script.js](script.js#L44-L46)

---

### Lỗi 2: "WebSocket connection failed"
**Nguyên nhân**: Port hoặc SSL sai

**Kiểm tra**:
- Port: 8884 (WSS) hoặc 8083 (WS)
- useSSL: true (cho port 8884)
- Path: "/mqtt"

**Giải pháp**:
```javascript
// Trong script.js dòng 40-48
host: "6ceea111b6144c71a57b21faa3553fc6.s1.eu.hivemq.cloud",
port: 8884,          // ← WSS port
useSSL: true,        // ← Bắt buộc true
path: "/mqtt"        // ← Đúng path
```

---

### Lỗi 3: "Paho is not defined"
**Nguyên nhân**: Thư viện chưa load

**Giải pháp**: Đã fix tự động retry sau 1s

**Kiểm tra thủ công**:
1. Mở Console
2. Gõ: `typeof Paho`
3. Nếu trả về `"undefined"` → Thư viện chưa load
4. Kiểm tra Network tab xem file `mqttws31.min.js` có load thành công không

---

### Lỗi 4: "Connection timeout"
**Nguyên nhân**: Firewall hoặc network

**Giải pháp**:
1. Kiểm tra firewall không chặn cổng 8884
2. Thử kết nối từ mạng khác
3. Dùng VPN nếu mạng công ty chặn

---

## 🧪 TEST NHANH:

### Test 1: Kiểm tra kết nối từ browser
Mở Console và chạy:
```javascript
// Tạo test client
const testClient = new Paho.MQTT.Client(
  "6ceea111b6144c71a57b21faa3553fc6.s1.eu.hivemq.cloud",
  8884,
  "/mqtt",
  "test_" + Date.now()
);

// Kết nối
testClient.connect({
  onSuccess: () => console.log("✅ Test MQTT OK!"),
  onFailure: (e) => console.error("❌ Test MQTT Failed:", e),
  useSSL: true,
  userName: "SmartHome",
  password: "SmartHome01",
  timeout: 10
});
```

### Test 2: Kiểm tra từ MQTT Client khác
Dùng **MQTT Explorer** hoặc **MQTTX**:
- Host: `6ceea111b6144c71a57b21faa3553fc6.s1.eu.hivemq.cloud`
- Port: 8883 (MQTTS) hoặc 8884 (WSS)
- Username: `SmartHome`
- Password: `SmartHome01`
- SSL/TLS: Enabled

---

## 📋 CHECKLIST KIỂM TRA:

- [ ] Badge hiển thị "MQTT: Connected" (màu xanh)
- [ ] Console không có lỗi màu đỏ
- [ ] Có log "MQTT Connected to ..."
- [ ] Có log "Subscribed to: SmartHome/..."
- [ ] ESP32 publish → Web nhận được data
- [ ] Web gửi lệnh → ESP32 nhận và thực hiện

---

## 🆘 NẾU VẪN KHÔNG ĐƯỢC:

### Phương án 1: Dùng EMQX Public (không cần auth)
Sửa trong script.js:
```javascript
return {
    host: "broker.emqx.io",
    port: 8083,
    path: "/mqtt",
    useSSL: false,
    username: "",
    password: "",
    keepalive: 60,
    reconnect: true,
    clientId: "WebDashboard_" + Math.random().toString(16).substr(2, 8)
};
```

### Phương án 2: Dùng HiveMQ Public
```javascript
return {
    host: "broker.hivemq.com",
    port: 8000,
    path: "/mqtt",
    useSSL: false,
    username: "",
    password: "",
    keepalive: 60,
    reconnect: true,
    clientId: "WebDashboard_" + Math.random().toString(16).substr(2, 8)
};
```

### Phương án 3: Chỉ dùng Firebase (tắt MQTT)
Comment dòng `connectMQTT()` trong script.js và ẩn MQTT badge.

---

## 📞 DEBUG STEPS:

1. **Refresh trang** (Ctrl+F5 hoặc Cmd+Shift+R)
2. **Mở Console** (F12)
3. **Copy toàn bộ log** màu đỏ
4. **Screenshot** màu đỏ
5. **Gửi cho tôi** để phân tích

---

## ✨ SAU KHI KẾT NỐI THÀNH CÔNG:

Badge sẽ hiển thị:
```
🟢 MQTT: Connected (6ceea111b6144c71a57b21faa3553fc6.s1.eu.hivemq.cloud)
🟢 Firebase: Connected
🟢 WiFi: Đang kiểm tra...
```

Console sẽ có:
```
Đang kết nối MQTT: {host: "6ceea111b6144c71a57b21faa3553fc6.s1.eu.hivemq.cloud", ...}
MQTT Connected to 6ceea111b6144c71a57b21faa3553fc6.s1.eu.hivemq.cloud
Subscribed to: SmartHome/esp_01/data
Subscribed to: SmartHome/esp_01/state
Subscribed to: SmartHome/esp_01/info
```
