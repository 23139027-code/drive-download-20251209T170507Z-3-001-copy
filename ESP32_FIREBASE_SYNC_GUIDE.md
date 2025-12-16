# Hướng Dẫn Đồng Bộ ESP32 với Firebase Realtime Database

## 📋 Mục Đích

File này hướng dẫn người lập trình ESP32 cách khai báo và đồng bộ các biến với cấu trúc Firebase Realtime Database của hệ thống.

## 🗂️ Cấu Trúc Firebase

Dựa trên ảnh chụp Firebase Console, cấu trúc dữ liệu như sau:

```
devices/
  └─ esp32_01/
      ├─ ac_active: false          (bool) - Trạng thái máy lạnh
      ├─ active: true               (bool) - Trạng thái thiết bị chính
      ├─ fan_active: false          (bool) - Trạng thái quạt gió
      ├─ humid: 85                  (number) - Độ ẩm (%)
      ├─ interval: 5                (number) - Chu kỳ gửi data (giây)
      ├─ lamp_active: false         (bool) - Trạng thái đèn
      ├─ last_update: 1765852000941 (number) - Timestamp cập nhật cuối
      ├─ lux: 1052                  (number) - Ánh sáng (Lux)
      ├─ mode: "periodic"           (string) - Chế độ hoạt động
      ├─ name: "phòng khách"        (string) - Tên thiết bị
      ├─ temp: 35                   (number) - Nhiệt độ (°C)
      └─ wifi_ssid: "Coffee_Highlands" (string) - Tên WiFi đang kết nối
```

## 💾 Khai Báo Biến trong ESP32

### 1. Biến Trạng Thái (Control Variables)

```cpp
// ========== BIẾN ĐỒNG BỘ VỚI FIREBASE ==========

// Trạng thái thiết bị chính
bool deviceActive = false;        // devices/{id}/active
                                  // true = đang đo, false = đã tắt

// Trạng thái các thiết bị điều khiển
bool fanActive = false;           // devices/{id}/fan_active
bool lampActive = false;          // devices/{id}/lamp_active
bool acActive = false;            // devices/{id}/ac_active

// Cấu hình
int sendInterval = 5;             // devices/{id}/interval (giây)
String deviceMode = "periodic";   // devices/{id}/mode
String deviceName = "phòng khách"; // devices/{id}/name (chỉ đọc)

// Dữ liệu sensor
float temperature = 0.0;          // devices/{id}/temp
float humidity = 0.0;             // devices/{id}/humid
int lightLevel = 0;               // devices/{id}/lux

// Thông tin hệ thống
String wifiSSID = "";             // devices/{id}/wifi_ssid
unsigned long lastUpdate = 0;     // devices/{id}/last_update (timestamp)
```

### 2. Giải Thích Từng Biến

#### `deviceActive` (bool)
- **Mục đích:** Trạng thái hoạt động của thiết bị
- **Điều khiển:** Web gửi lệnh START/STOP qua MQTT
- **Hành vi ESP32:**
  ```cpp
  if (deviceActive == true) {
      // Đọc sensor và gửi data định kỳ
      readAndSendSensorData();
  } else {
      // Không đọc sensor, chờ lệnh START
      // Tất cả output devices cũng tắt
  }
  ```

#### `fanActive`, `lampActive`, `acActive` (bool)
- **Mục đích:** Trạng thái từng thiết bị đầu ra
- **Điều khiển:** Web gửi lệnh FAN/LAMP/AC qua MQTT
- **Hành vi ESP32:**
  ```cpp
  digitalWrite(FAN_PIN, fanActive ? HIGH : LOW);
  digitalWrite(LAMP_PIN, lampActive ? HIGH : LOW);
  digitalWrite(AC_PIN, acActive ? HIGH : LOW);
  ```
- **Lưu ý:** Khi `deviceActive = false`, tất cả phải tắt

#### `sendInterval` (int)
- **Mục đích:** Chu kỳ gửi dữ liệu sensor (giây)
- **Giá trị:** 5-300 giây (5s - 5 phút)
- **Mặc định:** 5 giây (như trong ảnh)
- **Hành vi ESP32:**
  ```cpp
  if (millis() - lastSend >= sendInterval * 1000) {
      readAndSendSensorData();
      lastSend = millis();
  }
  ```

#### `deviceMode` (string)
- **Mục đích:** Chế độ hoạt động
- **Giá trị:** "periodic" (đo định kỳ)
- **Tương lai:** Có thể mở rộng "manual", "auto", v.v.
- **Hiện tại:** Chỉ hỗ trợ "periodic"

#### `deviceName` (string)
- **Mục đích:** Tên hiển thị trong Web
- **Giá trị:** "phòng khách", "phòng ngủ", v.v.
- **ESP32:** Chỉ đọc, không cần xử lý (Web quản lý)

#### `temperature`, `humidity`, `lightLevel` (number)
- **Mục đích:** Dữ liệu từ sensors
- **Nguồn:** DHT22 (temp, humid), LDR (lux)
- **Hành vi ESP32:**
  ```cpp
  temperature = dht.readTemperature();  // °C
  humidity = dht.readHumidity();        // %
  lightLevel = map(analogRead(LDR_PIN), 0, 4095, 0, 2000); // Lux
  ```
- **Gửi lên Firebase:** Qua MQTT → Web → Firebase

#### `wifiSSID` (string)
- **Mục đích:** Tên WiFi đang kết nối
- **Giá trị:** "Coffee_Highlands" (như trong ảnh)
- **Hành vi ESP32:**
  ```cpp
  wifiSSID = WiFi.SSID();
  ```

#### `lastUpdate` (number)
- **Mục đích:** Timestamp cập nhật cuối (milliseconds)
- **Giá trị:** Unix timestamp (1765852000941)
- **Hành vi ESP32:**
  ```cpp
  lastUpdate = millis();
  // Hoặc dùng NTP time nếu cần chính xác
  ```

## 📤 Gửi Data Lên Firebase (Qua MQTT)

### Payload JSON Chuẩn

ESP32 gửi data qua MQTT topic `DATALOGGER/{deviceId}/DATA`:

```json
{
  "temp": 35,
  "humid": 85,
  "lux": 1052,
  "wifi_ssid": "Coffee_Highlands"
}
```

### Code Gửi Data

```cpp
void readAndSendSensorData() {
  if (!deviceActive) return;  // Không gửi nếu device tắt

  // 1. Đọc sensors
  temperature = dht.readTemperature();
  humidity = dht.readHumidity();
  int ldrValue = analogRead(LDR_PIN);
  lightLevel = map(ldrValue, 0, 4095, 0, 2000);
  wifiSSID = WiFi.SSID();

  // 2. Validate data
  if (isnan(temperature) || isnan(humidity)) {
    Serial.println("❌ Sensor read failed!");
    return;
  }

  // 3. Tạo JSON payload
  StaticJsonDocument<200> doc;
  doc["temp"] = round(temperature * 10) / 10.0;  // 1 chữ số thập phân
  doc["humid"] = round(humidity);                 // Làm tròn
  doc["lux"] = lightLevel;
  doc["wifi_ssid"] = wifiSSID;

  String payload;
  serializeJson(doc, payload);

  // 4. Gửi qua MQTT
  String topic = "DATALOGGER/" + String(deviceId) + "/DATA";
  if (client.publish(topic.c_str(), payload.c_str())) {
    Serial.println("✓ Data sent: " + payload);
    lastUpdate = millis();
  } else {
    Serial.println("✗ Failed to send data");
  }
}
```

**Lưu ý:**
- Web sẽ nhận data từ MQTT và tự động cập nhật Firebase
- ESP32 **KHÔNG** ghi trực tiếp vào Firebase
- Các field `active`, `fan_active`, `lamp_active`, `ac_active`, `interval`, `mode`, `name`, `last_update` do Web quản lý

## 📥 Nhận Lệnh Từ Web (Qua MQTT)

### Lệnh START

```json
{"cmd":"START","val":""}
```

**Xử lý:**
```cpp
if (cmd == "START") {
  deviceActive = true;
  Serial.println("✓ Device STARTED");
  // Bắt đầu đọc và gửi data định kỳ
}
```

### Lệnh STOP

```json
{"cmd":"STOP","val":""}
```

**Xử lý:**
```cpp
if (cmd == "STOP") {
  deviceActive = false;
  
  // Tắt TẤT CẢ output devices
  fanActive = false;
  lampActive = false;
  acActive = false;
  
  digitalWrite(FAN_PIN, LOW);
  digitalWrite(LAMP_PIN, LOW);
  digitalWrite(AC_PIN, LOW);
  
  Serial.println("✓ Device STOPPED");
}
```

### Lệnh FAN

```json
{"cmd":"FAN","val":"1"}  // Bật
{"cmd":"FAN","val":"0"}  // Tắt
```

**Xử lý:**
```cpp
if (cmd == "FAN") {
  fanActive = (val == "1");
  digitalWrite(FAN_PIN, fanActive ? HIGH : LOW);
  Serial.println("✓ Fan: " + String(fanActive ? "ON" : "OFF"));
}
```

### Lệnh LAMP

```json
{"cmd":"LAMP","val":"1"}  // Bật
{"cmd":"LAMP","val":"0"}  // Tắt
```

**Xử lý:**
```cpp
if (cmd == "LAMP") {
  lampActive = (val == "1");
  digitalWrite(LAMP_PIN, lampActive ? HIGH : LOW);
  Serial.println("✓ Lamp: " + String(lampActive ? "ON" : "OFF"));
}
```

### Lệnh AC (Máy lạnh)

```json
{"cmd":"AC","val":"1"}  // Bật
{"cmd":"AC","val":"0"}  // Tắt
```

**Xử lý:**
```cpp
if (cmd == "AC") {
  acActive = (val == "1");
  digitalWrite(AC_PIN, acActive ? HIGH : LOW);
  Serial.println("✓ AC: " + String(acActive ? "ON" : "OFF"));
}
```

### Lệnh INTERVAL (Nâng cao)

```json
{"cmd":"INTERVAL","val":"10"}  // Đổi chu kỳ thành 10s
```

**Xử lý:**
```cpp
if (cmd == "INTERVAL") {
  int newInterval = val.toInt();
  if (newInterval >= 5 && newInterval <= 300) {
    sendInterval = newInterval;
    Serial.println("✓ Interval changed to: " + String(sendInterval) + "s");
  } else {
    Serial.println("✗ Invalid interval (must be 5-300s)");
  }
}
```

## 🔄 Đồng Bộ Toàn Bộ

### Code Callback MQTT Hoàn Chỉnh

```cpp
void callback(char* topic, byte* payload, unsigned int length) {
  // Parse message
  String message = "";
  for (int i = 0; i < length; i++) {
    message += (char)payload[i];
  }

  Serial.println("\n━━━━━━━━━━━━━━━━━━━━━━━━━━");
  Serial.println("📨 MQTT Message Received");
  Serial.println("Topic: " + String(topic));
  Serial.println("Payload: " + message);

  // Parse JSON
  StaticJsonDocument<200> doc;
  DeserializationError error = deserializeJson(doc, message);
  
  if (error) {
    Serial.println("❌ JSON parse failed: " + String(error.c_str()));
    return;
  }

  String cmd = doc["cmd"];
  String val = doc["val"];

  Serial.println("Command: " + cmd);
  Serial.println("Value: " + val);

  // Xử lý các lệnh
  if (cmd == "START") {
    deviceActive = true;
    Serial.println("✅ Device STARTED");
    
  } else if (cmd == "STOP") {
    deviceActive = false;
    fanActive = false;
    lampActive = false;
    acActive = false;
    digitalWrite(FAN_PIN, LOW);
    digitalWrite(LAMP_PIN, LOW);
    digitalWrite(AC_PIN, LOW);
    Serial.println("✅ Device STOPPED + All outputs OFF");
    
  } else if (cmd == "FAN") {
    fanActive = (val == "1");
    digitalWrite(FAN_PIN, fanActive ? HIGH : LOW);
    Serial.println("✅ Fan: " + String(fanActive ? "ON" : "OFF"));
    
  } else if (cmd == "LAMP") {
    lampActive = (val == "1");
    digitalWrite(LAMP_PIN, lampActive ? HIGH : LOW);
    Serial.println("✅ Lamp: " + String(lampActive ? "ON" : "OFF"));
    
  } else if (cmd == "AC") {
    acActive = (val == "1");
    digitalWrite(AC_PIN, acActive ? HIGH : LOW);
    Serial.println("✅ AC: " + String(acActive ? "ON" : "OFF"));
    
  } else if (cmd == "INTERVAL") {
    int newInterval = val.toInt();
    if (newInterval >= 5 && newInterval <= 300) {
      sendInterval = newInterval;
      Serial.println("✅ Interval: " + String(sendInterval) + "s");
    } else {
      Serial.println("❌ Invalid interval");
    }
    
  } else {
    Serial.println("❓ Unknown command: " + cmd);
  }
  
  Serial.println("━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}
```

## 🎯 Checklist Đồng Bộ

### ✅ Khi Khởi Động ESP32:

```cpp
void setup() {
  // 1. Khởi tạo biến với giá trị mặc định
  deviceActive = false;
  fanActive = false;
  lampActive = false;
  acActive = false;
  sendInterval = 5;  // Khớp với Firebase default
  deviceMode = "periodic";
  
  // 2. Cấu hình pins
  pinMode(FAN_PIN, OUTPUT);
  pinMode(LAMP_PIN, OUTPUT);
  pinMode(AC_PIN, OUTPUT);
  digitalWrite(FAN_PIN, LOW);
  digitalWrite(LAMP_PIN, LOW);
  digitalWrite(AC_PIN, LOW);
  
  // 3. Kết nối WiFi
  setup_wifi();
  wifiSSID = WiFi.SSID();
  
  // 4. Kết nối MQTT
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(callback);
  reconnect();
  
  // 5. Sẵn sàng nhận lệnh
  Serial.println("✅ ESP32 Ready. Waiting for START command...");
}
```

### ✅ Trong Loop:

```cpp
void loop() {
  // 1. Đảm bảo MQTT connected
  if (!client.connected()) {
    reconnect();
  }
  client.loop();

  // 2. Gửi data nếu đã START và đủ thời gian
  if (deviceActive) {
    unsigned long now = millis();
    if (now - lastSend >= sendInterval * 1000) {
      readAndSendSensorData();
      lastSend = now;
    }
  }
  
  // 3. Các task khác (nếu có)
  // ...
}
```

## 📊 Bảng Tóm Tắt Biến

| Biến ESP32 | Firebase Field | Kiểu | Nguồn | Mô tả |
|------------|----------------|------|-------|-------|
| `deviceActive` | `active` | bool | Web → ESP32 (MQTT) | Trạng thái hoạt động chính |
| `fanActive` | `fan_active` | bool | Web → ESP32 (MQTT) | Trạng thái quạt |
| `lampActive` | `lamp_active` | bool | Web → ESP32 (MQTT) | Trạng thái đèn |
| `acActive` | `ac_active` | bool | Web → ESP32 (MQTT) | Trạng thái máy lạnh |
| `sendInterval` | `interval` | int | Web → ESP32 (MQTT) | Chu kỳ gửi (giây) |
| `deviceMode` | `mode` | string | Web quản lý | Chế độ hoạt động |
| `deviceName` | `name` | string | Web quản lý | Tên thiết bị |
| `temperature` | `temp` | float | ESP32 → Web (MQTT) | Nhiệt độ (°C) |
| `humidity` | `humid` | float | ESP32 → Web (MQTT) | Độ ẩm (%) |
| `lightLevel` | `lux` | int | ESP32 → Web (MQTT) | Ánh sáng (Lux) |
| `wifiSSID` | `wifi_ssid` | string | ESP32 → Web (MQTT) | Tên WiFi |
| `lastUpdate` | `last_update` | number | Web quản lý | Timestamp (ms) |

## 🔐 Quy Tắc Quan Trọng

### ❗ ESP32 KHÔNG được:
- ❌ Ghi trực tiếp vào Firebase
- ❌ Đọc từ Firebase (chỉ nhận qua MQTT)
- ❌ Tự ý thay đổi `interval`, `mode`, `name`
- ❌ Cập nhật `last_update` (Web làm)

### ✅ ESP32 CHỈ được:
- ✅ Đọc sensors (temp, humid, lux)
- ✅ Gửi data qua MQTT
- ✅ Nhận lệnh từ MQTT
- ✅ Điều khiển output pins (fan, lamp, ac)
- ✅ Report wifi_ssid

## 📝 Template Code Đầy Đủ

```cpp
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <DHT.h>

// ========== CẤU HÌNH ==========
const char* ssid = "YOUR_WIFI";
const char* password = "YOUR_PASSWORD";
const char* mqtt_server = "broker.emqx.io";
const int mqtt_port = 1883;
const char* deviceId = "esp32_01";  // ← Phải khớp với Firebase

// ========== PINS ==========
#define DHTPIN 4
#define DHTTYPE DHT22
#define LDR_PIN 34
#define FAN_PIN 25
#define LAMP_PIN 26
#define AC_PIN 27

// ========== OBJECTS ==========
WiFiClient espClient;
PubSubClient client(espClient);
DHT dht(DHTPIN, DHTTYPE);

// ========== BIẾN ĐỒNG BỘ VỚI FIREBASE ==========
bool deviceActive = false;
bool fanActive = false;
bool lampActive = false;
bool acActive = false;
int sendInterval = 5;
String deviceMode = "periodic";
String deviceName = "";
float temperature = 0.0;
float humidity = 0.0;
int lightLevel = 0;
String wifiSSID = "";
unsigned long lastUpdate = 0;
unsigned long lastSend = 0;

// ========== TOPICS ==========
String topicData = "DATALOGGER/" + String(deviceId) + "/DATA";
String topicCmd = "DATALOGGER/" + String(deviceId) + "/CMD";

// ========== FUNCTIONS ==========
void setup_wifi() { /* ... */ }
void reconnect() { /* ... */ }
void callback(char* topic, byte* payload, unsigned int length) { /* Như trên */ }
void readAndSendSensorData() { /* Như trên */ }

void setup() {
  Serial.begin(115200);
  
  // Init pins
  pinMode(FAN_PIN, OUTPUT);
  pinMode(LAMP_PIN, OUTPUT);
  pinMode(AC_PIN, OUTPUT);
  digitalWrite(FAN_PIN, LOW);
  digitalWrite(LAMP_PIN, LOW);
  digitalWrite(AC_PIN, LOW);
  
  // Init DHT
  dht.begin();
  
  // Connect WiFi
  setup_wifi();
  wifiSSID = WiFi.SSID();
  
  // Connect MQTT
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(callback);
  reconnect();
  
  Serial.println("✅ Ready");
}

void loop() {
  if (!client.connected()) reconnect();
  client.loop();
  
  if (deviceActive && (millis() - lastSend >= sendInterval * 1000)) {
    readAndSendSensorData();
    lastSend = millis();
  }
}
```

## 📡 Cấu Hình WiFi Lần Đầu (WiFi Setup Mode)

### Mục Đích

Khi ESP32 chưa có thông tin WiFi hoặc không kết nối được, cần chế độ cấu hình WiFi để user nhập SSID và password.

### Thông Tin Cần Gửi Lên Firebase

ESP32 cần gửi 2 thông tin quan trọng để Web hướng dẫn user:

```cpp
// Thông tin Access Point của ESP32 (khi ở chế độ setup)
String apSSID = "ESP32-Setup-" + String(deviceId);  // Tên WiFi AP
String apIP = "192.168.4.1";                        // IP mặc định của AP
```

### Cấu Trúc Firebase Bổ Sung

Thêm vào `devices/{deviceId}/`:

```json
{
  "setup_mode": true,              // ESP32 đang ở chế độ setup
  "ap_ssid": "ESP32-Setup-esp32_01",  // Tên WiFi AP của ESP32
  "ap_ip": "192.168.4.1",          // IP của ESP32 AP
  "wifi_ssid": ""                  // Rỗng khi chưa kết nối
}
```

### Code ESP32 - WiFi Setup Mode

#### 1. Kiểm Tra WiFi Kết Nối

```cpp
#include <WiFi.h>
#include <WiFiManager.h>  // https://github.com/tzapu/WiFiManager

WiFiManager wifiManager;
const char* deviceId = "esp32_01";
bool isSetupMode = false;

void setup() {
  Serial.begin(115200);
  
  // Thử kết nối WiFi đã lưu
  Serial.println("⏳ Connecting to saved WiFi...");
  WiFi.mode(WIFI_STA);
  WiFi.begin();
  
  // Đợi 10 giây
  int timeout = 10;
  while (WiFi.status() != WL_CONNECTED && timeout > 0) {
    delay(1000);
    Serial.print(".");
    timeout--;
  }
  
  if (WiFi.status() != WL_CONNECTED) {
    // Không kết nối được → Chuyển sang Setup Mode
    Serial.println("\n❌ WiFi connection failed. Entering Setup Mode...");
    enterSetupMode();
  } else {
    // Kết nối thành công
    Serial.println("\n✅ WiFi connected!");
    Serial.println("IP: " + WiFi.localIP().toString());
    Serial.println("SSID: " + WiFi.SSID());
    isSetupMode = false;
    
    // Gửi thông tin lên Firebase qua MQTT
    updateFirebaseStatus();
  }
}

void enterSetupMode() {
  isSetupMode = true;
  
  // Tạo tên AP unique
  String apSSID = "ESP32-Setup-" + String(deviceId);
  String apPassword = "";  // Không mật khẩu (open network)
  
  Serial.println("\n━━━━━━━━━━━━━━━━━━━━━━━━━━");
  Serial.println("🔧 SETUP MODE ACTIVE");
  Serial.println("━━━━━━━━━━━━━━━━━━━━━━━━━━");
  Serial.println("AP SSID: " + apSSID);
  Serial.println("AP IP: 192.168.4.1");
  Serial.println("━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  
  // Gửi thông tin Setup Mode lên Firebase (qua MQTT nếu có kết nối)
  // Hoặc dùng WiFi tạm để gửi (advanced)
  
  // Khởi động WiFiManager Portal
  wifiManager.setConfigPortalTimeout(300);  // 5 phút timeout
  wifiManager.autoConnect(apSSID.c_str(), apPassword.c_str());
  
  // Sau khi config xong, WiFiManager tự động kết nối
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("✅ WiFi configured successfully!");
    Serial.println("SSID: " + WiFi.SSID());
    Serial.println("IP: " + WiFi.localIP().toString());
    isSetupMode = false;
    updateFirebaseStatus();
    ESP.restart();  // Restart để vào chế độ bình thường
  }
}

void updateFirebaseStatus() {
  // Gửi qua MQTT
  StaticJsonDocument<300> doc;
  doc["setup_mode"] = isSetupMode;
  doc["ap_ssid"] = isSetupMode ? ("ESP32-Setup-" + String(deviceId)) : "";
  doc["ap_ip"] = isSetupMode ? "192.168.4.1" : "";
  doc["wifi_ssid"] = isSetupMode ? "" : WiFi.SSID();
  doc["ip_address"] = isSetupMode ? "" : WiFi.localIP().toString();
  
  String payload;
  serializeJson(doc, payload);
  
  String topic = "DATALOGGER/" + String(deviceId) + "/STATUS";
  client.publish(topic.c_str(), payload.c_str());
}
```

#### 2. Library Cần Thiết

```cpp
// platformio.ini hoặc Arduino IDE Library Manager
lib_deps =
  tzapu/WiFiManager @ ^2.0.16-rc.2
  knolleary/PubSubClient @ ^2.8
  bblanchon/ArduinoJson @ ^6.21.3
```

### Luồng Hoạt Động

```
┌─────────────────────────────────────────────────────────────┐
│ 1. ESP32 Boot                                               │
│    ↓                                                        │
│ 2. Thử kết nối WiFi đã lưu (10s timeout)                   │
│    ↓                                                        │
│ 3a. Thành công → Gửi wifi_ssid lên Firebase → Normal Mode │
│    ↓                                                        │
│ 3b. Thất bại → Setup Mode                                  │
│     - Tạo AP: "ESP32-Setup-esp32_01"                       │
│     - IP: 192.168.4.1                                      │
│     - Gửi {setup_mode: true, ap_ssid, ap_ip} lên Firebase │
│     ↓                                                        │
│ 4. User vào Web Dashboard → Click "Hướng dẫn WiFi"         │
│    ↓                                                        │
│ 5. Web lấy ap_ssid, ap_ip từ Firebase                      │
│    ↓                                                        │
│ 6. Hiển thị hướng dẫn:                                     │
│    - Kết nối vào "ESP32-Setup-esp32_01"                   │
│    - Truy cập 192.168.4.1                                  │
│    - Chọn WiFi gia đình và nhập password                   │
│    ↓                                                        │
│ 7. ESP32 nhận config → Kết nối WiFi → Restart → Normal    │
└─────────────────────────────────────────────────────────────┘
```

### Web Dashboard - Hiển Thị Hướng Dẫn Động

Web sẽ lấy thông tin từ Firebase và hiển thị:

```javascript
// script.js
async function showWiFiSetupGuide() {
  const instructionsDiv = document.getElementById('wifi-setup-instructions');
  
  // Lấy danh sách devices từ Firebase
  const devicesRef = ref(db, 'devices');
  const snapshot = await get(devicesRef);
  
  if (!snapshot.exists()) {
    instructionsDiv.innerHTML = `
      <p style="color: #dc2626;">❌ Không tìm thấy thiết bị nào. Vui lòng thêm thiết bị trước.</p>
    `;
    instructionsDiv.style.display = 'block';
    return;
  }
  
  const devices = snapshot.val();
  let setupDevices = [];
  
  // Tìm devices đang ở Setup Mode
  for (const [id, data] of Object.entries(devices)) {
    if (data.setup_mode === true) {
      setupDevices.push({
        id: id,
        name: data.name,
        ap_ssid: data.ap_ssid,
        ap_ip: data.ap_ip
      });
    }
  }
  
  if (setupDevices.length === 0) {
    instructionsDiv.innerHTML = `
      <p style="color: #059669;">✅ Tất cả thiết bị đã kết nối WiFi.</p>
      <p style="color: #666; font-size: 0.85rem;">Nếu bạn muốn đổi WiFi, vui lòng reset ESP32 hoặc xóa WiFi đã lưu trong code.</p>
    `;
  } else {
    // Hiển thị hướng dẫn cho từng thiết bị
    let html = '<h5 style="margin: 0 0 10px 0; color: #92400e;">📱 Thiết bị cần cấu hình WiFi:</h5>';
    
    setupDevices.forEach((dev, index) => {
      html += `
        <div style="margin: 15px 0; padding: 15px; background: #fffbeb; border-radius: 6px; border: 1px solid #fbbf24;">
          <h6 style="margin: 0 0 10px 0; color: #92400e;">${index + 1}. ${dev.name} (${dev.id})</h6>
          <ol style="margin: 5px 0; padding-left: 20px; color: #78350f; font-size: 0.85rem; line-height: 1.6;">
            <li>Bật điện thoại/laptop, vào <strong>Cài đặt WiFi</strong></li>
            <li>Tìm và kết nối vào WiFi: <strong style="color: #ea580c;">${dev.ap_ssid}</strong> (không cần mật khẩu)</li>
            <li>Trình duyệt tự động mở trang cấu hình<br>
                <span style="font-size: 0.8rem; color: #666;">(Nếu không tự mở, truy cập: <code>${dev.ap_ip}</code>)</span>
            </li>
            <li>Chọn WiFi gia đình của bạn trong danh sách</li>
            <li>Nhập mật khẩu WiFi và nhấn <strong>"Save"</strong></li>
            <li>ESP32 sẽ tự động kết nối và xuất hiện trên Dashboard trong vài giây</li>
          </ol>
        </div>
      `;
    });
    
    instructionsDiv.innerHTML = html;
  }
  
  instructionsDiv.style.display = 'block';
}
```

### Lưu Ý Quan Trọng

1. **Setup Mode Detection:**
   - ESP32 gửi `setup_mode: true` lên Firebase khi vào Setup Mode
   - Web check field này để hiển thị hướng dẫn

2. **AP SSID Naming:**
   - Format: `ESP32-Setup-{deviceId}`
   - Ví dụ: `ESP32-Setup-esp32_01`, `ESP32-Setup-esp32_02`
   - Giúp user biết đang config thiết bị nào

3. **Security:**
   - AP không password (open) để dễ kết nối
   - Portal chỉ cho phép config WiFi, không có quyền truy cập khác
   - Timeout 5 phút để tránh AP mở mãi

4. **Firebase Topic:**
   - Thêm topic mới: `DATALOGGER/{deviceId}/STATUS`
   - Để gửi thông tin setup_mode, ap_ssid, ap_ip
   - Web subscribe topic này để cập nhật realtime

## 🎓 Kết Luận

**Nguyên tắc đồng bộ:**
1. **ESP32 → MQTT → Web → Firebase** (Gửi data sensor)
2. **Web → MQTT → ESP32** (Nhận lệnh điều khiển)
3. **Firebase = Single source of truth** (Web quản lý tất cả metadata)

**Khai báo biến đúng chuẩn:**
- Khớp kiểu dữ liệu (bool, int, float, string)
- Khớp tên field với Firebase
- Xử lý đúng luồng (START → đọc sensor → gửi MQTT)
- Output devices tắt khi STOP

**WiFi Setup Flow:**
- ESP32 tự động vào Setup Mode nếu không kết nối được
- Gửi thông tin AP (SSID, IP) lên Firebase
- Web hiển thị hướng dẫn động dựa trên thông tin thực tế
- User config WiFi qua portal → ESP32 restart → Normal Mode

---

**📚 Xem thêm:**
- `ESP32_MQTT_GUIDE.md` - Hướng dẫn cấu hình MQTT chi tiết
- `errors_report.txt` - Phân tích kiến trúc hệ thống
- [WiFiManager Library](https://github.com/tzapu/WiFiManager) - Thư viện WiFi setup cho ESP32

**🚀 Happy coding!**
