// script.js
import { db, auth } from './firebase-config.js'; // Import cấu hình chung
import { requireAuth, logout } from './auth.js'; // Import hàm tiện ích
import { ref, onValue, set, update, get, push, remove, query, limitToLast, orderByChild, equalTo } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

// --- 1. KHAI BÁO BIẾN TOÀN CỤC (BẮT BUỘC) ---
let myChartInstance = null;      // Biến giữ biểu đồ
let currentChartType = null;     // Loại biểu đồ đang chọn
let currentReportDeviceId = null; // ID thiết bị đang xem báo cáo
// Biến lưu dữ liệu lịch sử để vẽ
let cachedHistoryData = { labels: [], temps: [], humids: [], lights: [] };
let commandCounter = 0;          // Biến đếm lệnh MQTT
// 1. Kiểm tra Login ngay lập tức
requireAuth();

// --- CẤU HÌNH MQTT ---
// Load cấu hình MQTT từ localStorage hoặc dùng mặc định
function loadMQTTConfig() {
    const savedConfig = localStorage.getItem('mqtt_config');
    if (savedConfig) {
        try {
            const config = JSON.parse(savedConfig);
            return {
                host: config.host || "broker.emqx.io",
                port: config.port || 8083,
                path: config.path || "/mqtt",
                useSSL: config.useSSL || false,
                username: config.username || "",
                password: config.password || "",
                keepalive: config.keepalive || 60,
                clientId: "WebDashboard_" + Math.random().toString(16).substr(2, 8)
            };
        } catch (e) {
            console.error("Lỗi load MQTT config:", e);
        }
    }
    // Cấu hình mặc định - HiveMQ Cloud
    return {
        host: "6ceea111b6144c71a57b21faa3553fc6.s1.eu.hivemq.cloud",
        port: 8884,
        path: "/mqtt",
        useSSL: true,
        username: "",
        password: "",
        keepalive: 60,
        clientId: "WebDashboard_" + Math.random().toString(16).substr(2, 8)
    };
}

const mqttConfig = loadMQTTConfig();
let mqttClient;
let subscribedDevices = new Set(); // Track các thiết bị đã subscribe

document.addEventListener('DOMContentLoaded', () => {
    // 2. Gán sự kiện Logout
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            if (confirm("Bạn có chắc muốn đăng xuất?")) {
                logout().then(() => window.location.href = 'login.html');
            }
        });
    }

    const sidebar = document.getElementById('sidebar');
    const mainContent = document.querySelector('.main-content');
    const toggleBtn = document.getElementById('sidebar-toggle');

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            // Toggle class 'collapsed' cho sidebar
            sidebar.classList.toggle('collapsed');

            // Toggle class 'expanded' cho nội dung chính
            mainContent.classList.toggle('expanded');
        });
    }

    // Kết nối Firebase & MQTT
    updateStatus('db-status', 'warning', 'Firebase: Connecting...');
    initFirebaseApp();
    
    // Đợi thư viện Paho MQTT load xong
    if (typeof Paho === 'undefined') {
        console.warn('Paho MQTT chưa load, đợi 1s...');
        setTimeout(connectMQTT, 1000);
    } else {
        connectMQTT();
    }

    // Setup các chức năng khác
    setupModal();
    setupEditModal();
    setupMasterSwitch();
});
//--- Kiểm tra kết nối Firebase để cập nhật trạng thái ---
function monitorConnection() {
    const statusBadge = document.getElementById('db-status');
    // .info/connected là đường dẫn đặc biệt của Firebase để check kết nối
    const connectedRef = ref(db, ".info/connected");

    onValue(connectedRef, (snap) => {
        if (snap.val() === true) {
            statusBadge.textContent = "Firebase: Connected";
            statusBadge.className = "badge success"; // Màu xanh
        } else {
            statusBadge.textContent = "Firebase: Disconnected";
            statusBadge.className = "badge error";   // Màu đỏ
        }
    });
}

// --- CÁC HÀM MQTT ---
function connectMQTT() {
    // Kiểm tra Paho MQTT đã load chưa
    if (typeof Paho === 'undefined') {
        console.error('Lỗi: Thư viện Paho MQTT chưa được load!');
        updateStatus('mqtt-status', 'error', 'MQTT: Library not loaded');
        return;
    }
    
    try {
        console.log('Đang kết nối MQTT:', mqttConfig);
        mqttClient = new Paho.MQTT.Client(mqttConfig.host, mqttConfig.port, mqttConfig.path, mqttConfig.clientId);
        
        // Handler khi mất kết nối
        mqttClient.onConnectionLost = (obj) => {
            console.log("MQTT Lost:", obj.errorMessage);
            updateStatus('mqtt-status', 'error', 'MQTT: Lost');
            subscribedDevices.clear(); // Clear danh sách subscribe
        };
        
        // Handler nhận message từ ESP32
        mqttClient.onMessageArrived = (message) => {
            handleMQTTMessage(message);
        };
        
        // Tạo connect options từ config
        const connectOptions = {
            onSuccess: () => {
                console.log("MQTT Connected to", mqttConfig.host);
                updateStatus('mqtt-status', 'success', 'MQTT: Connected');
                // Subscribe các topic từ devices hiện có
                subscribeToAllDevices();
            },
            onFailure: (e) => {
                console.error("MQTT Kết nối thất bại:", e);
                console.error("Error code:", e.errorCode);
                console.error("Error message:", e.errorMessage);
                updateStatus('mqtt-status', 'error', 'MQTT: Failed');
                
                // Tự động thử kết nối lại sau 5 giây
                setTimeout(() => {
                    console.log("Đang thử kết nối lại MQTT...");
                    connectMQTT();
                }, 5000);
            },
            useSSL: mqttConfig.useSSL,
            keepAliveInterval: mqttConfig.keepalive,
            cleanSession: true,
            timeout: 10
        };
        
        // Thêm username/password nếu có
        if (mqttConfig.username) {
            connectOptions.userName = mqttConfig.username;
            connectOptions.password = mqttConfig.password;
        }
        
        mqttClient.connect(connectOptions);
    } catch (e) {
        console.error("Lỗi khởi tạo MQTT:", e);
    }
}

// Hàm kiểm tra MQTT connected
function isMQTTConnected() {
    let connected = false;
    try {
        if (!mqttClient) connected = false;
        else if (typeof mqttClient.isConnected === 'function') connected = mqttClient.isConnected();
        else if (typeof mqttClient.isConnected !== 'function' && mqttClient.isConnected !== undefined) connected = !!mqttClient.isConnected;
        else if (mqttClient.connected !== undefined) connected = !!mqttClient.connected;
    } catch (e) {
        connected = false;
    }
    return connected;
}

// Subscribe tất cả devices khi kết nối MQTT
async function subscribeToAllDevices() {
    try {
        const snapshot = await get(ref(db, 'devices'));
        if (snapshot.exists()) {
            const devices = snapshot.val();
            Object.keys(devices).forEach(deviceId => {
                subscribeDevice(deviceId);
            });
        }
    } catch (err) {
        console.error("Lỗi subscribe devices:", err);
    }
}

// Subscribe 1 device cụ thể
function subscribeDevice(deviceId) {
    if (!isMQTTConnected()) return;
    
    // Subscribe tất cả topics theo cấu trúc SmartHome
    const topics = [
        `SmartHome/${deviceId}/data`,      // Dữ liệu sensor
        `SmartHome/${deviceId}/state`,     // Trạng thái thiết bị
        `SmartHome/${deviceId}/info`       // Thông tin thiết bị
    ];
    
    if (!subscribedDevices.has(deviceId)) {
        try {
            topics.forEach(topic => {
                mqttClient.subscribe(topic);
                console.log(`Subscribed to: ${topic}`);
            });
            subscribedDevices.add(deviceId);
        } catch (e) {
            console.error(`Lỗi subscribe ${deviceId}:`, e);
        }
    }
}

// Xử lý message MQTT nhận được từ ESP32
function handleMQTTMessage(message) {
    try {
        const topic = message.destinationName;
        const payload = JSON.parse(message.payloadString);
        
        console.log("MQTT Received:", topic, payload);
        
        // Extract deviceId và type từ topic: SmartHome/{deviceId}/{type}
        const parts = topic.split('/');
        if (parts.length >= 3 && parts[0] === 'SmartHome') {
            const deviceId = parts[1];
            const messageType = parts[2]; // data, state, hoặc info
            
            // Xử lý theo loại message
            if (messageType === 'data') {
                // Dữ liệu sensor: temperature, humidity, light
                updateFirebaseFromMQTT(deviceId, payload, 'data');
            } else if (messageType === 'state') {
                // Trạng thái: mode, interval, fan, light, ac
                updateFirebaseFromMQTT(deviceId, payload, 'state');
            } else if (messageType === 'info') {
                // Thông tin: ssid, ip, broker, firmware
                updateFirebaseFromMQTT(deviceId, payload, 'info');
            }
        }
    } catch (err) {
        console.error("Lỗi xử lý MQTT message:", err);
    }
}

// Cập nhật dữ liệu từ MQTT lên Firebase (chỉ để lưu trữ)
async function updateFirebaseFromMQTT(deviceId, payload, messageType) {
    try {
        // Ưu tiên dùng timestamp từ ESP32, nếu không có thì dùng thời gian web
        // Timestamp từ ESP32 sẽ chính xác sau khi đồng bộ
        let timestamp;
        if (payload.timestamp) {
            // ESP32 gửi timestamp (Unix timestamp tính bằng giây)
            // Chuyển sang milliseconds để phù hợp với JavaScript Date
            timestamp = payload.timestamp * 1000;
        } else {
            // Fallback: dùng thời gian web nếu ESP không gửi timestamp
            timestamp = Date.now();
        }
        
        const updates = {
            last_update: timestamp
        };
        
        if (messageType === 'data') {
            // Dữ liệu sensor từ SmartHome/{deviceId}/data
            if (payload.temperature !== undefined) updates.temp = payload.temperature;
            if (payload.humidity !== undefined) updates.humid = payload.humidity;
            if (payload.light !== undefined) updates.lux = payload.light;
            
            // Cập nhật vào devices
            await update(ref(db, `devices/${deviceId}`), updates);
            
            // Lưu vào history nếu có đủ dữ liệu sensor
            if (payload.temperature !== undefined && payload.humidity !== undefined && payload.light !== undefined) {
                const historyData = {
                    temp: payload.temperature,
                    humid: payload.humidity,
                    lux: payload.light,
                    last_update: timestamp
                };
                await push(ref(db, `history/${deviceId}`), historyData);
            }
            
        } else if (messageType === 'state') {
            // Trạng thái từ SmartHome/{deviceId}/state
            if (payload.mode !== undefined) updates.active = payload.mode === 1;
            if (payload.interval !== undefined) updates.interval = payload.interval;
            if (payload.fan !== undefined) updates.fan_active = payload.fan === 1;
            if (payload.light !== undefined) updates.lamp_active = payload.light === 1;
            if (payload.ac !== undefined) updates.ac_active = payload.ac === 1;
            
            await update(ref(db, `devices/${deviceId}`), updates);
            
        } else if (messageType === 'info') {
            // Thông tin từ SmartHome/{deviceId}/info
            if (payload.ssid !== undefined) updates.wifi_ssid = payload.ssid;
            if (payload.ip !== undefined) updates.ip_address = payload.ip;
            if (payload.broker !== undefined) updates.mqtt_broker = payload.broker;
            if (payload.firmware !== undefined) updates.firmware = payload.firmware;
            
            await update(ref(db, `devices/${deviceId}`), updates);
        }
    } catch (err) {
        console.error("Lỗi cập nhật Firebase:", err);
    }
}

// Gửi lệnh điều khiển qua MQTT
function sendCommand(deviceId, cmd, val = "") {
    if (!isMQTTConnected()) {
        alert("Chưa kết nối MQTT! Không thể gửi lệnh.");
        return false;
    }

    const topic = `SmartHome/${deviceId}/command`;
    
    // Tăng biến đếm lệnh
    commandCounter++;
    
    // Tạo payload theo format chung
    const cmdPayload = {
        id: "cmd_" + commandCounter.toString().padStart(3, '0'),
        command: "",
        params: {}
    };
    
    // Map lệnh sang format mới theo MQTT_COMMANDS.md
    if (cmd === 'START') {
        cmdPayload.command = "set_mode";
        cmdPayload.params.mode = 1;
        console.log(`[DEBUG] Command START mapped to set_mode with mode=1`);
    } else if (cmd === 'STOP') {
        cmdPayload.command = "set_mode";
        cmdPayload.params.mode = 0;
        console.log(`[DEBUG] Command STOP mapped to set_mode with mode=0`);
    } else if (cmd === 'FAN') {
        cmdPayload.command = "set_device";
        cmdPayload.params.device = "fan";
        cmdPayload.params.state = parseInt(val);
    } else if (cmd === 'LAMP') {
        cmdPayload.command = "set_device";
        cmdPayload.params.device = "light";
        cmdPayload.params.state = parseInt(val);
    } else if (cmd === 'AC') {
        cmdPayload.command = "set_device";
        cmdPayload.params.device = "ac";
        cmdPayload.params.state = parseInt(val);
    } else if (cmd === 'INTERVAL') {
        cmdPayload.command = "set_interval";
        cmdPayload.params.interval = parseInt(val);
    }
    
    const payload = JSON.stringify(cmdPayload);
    const message = new Paho.MQTT.Message(payload);
    message.destinationName = topic;
    
    try {
        mqttClient.send(message);
        console.log(`✅ MQTT Sent [${topic}]:`, payload);
        console.log(`📦 Parsed JSON:`, JSON.parse(payload));
        return true;
    } catch (e) {
        console.error("Lỗi gửi MQTT:", e);
        return false;
    }
}

// --- CÁC HÀM FIREBASE ---
function initFirebaseApp() {
    const devicesRef = ref(db, 'devices');
    onValue(devicesRef, (snapshot) => {
        updateStatus('db-status', 'success', 'Firebase: Connected');
        const data = snapshot.val();
        renderGrid(data || {}); // Xử lý trường hợp data null
        
        // Cập nhật trạng thái WiFi từ thiết bị đầu tiên có dữ liệu
        updateWiFiStatus(data);
    });
}

// Hàm cập nhật trạng thái WiFi
function updateWiFiStatus(devicesData) {
    if (!devicesData) {
        updateStatus('wifi-status', 'error', 'WiFi: Không kết nối');
        return;
    }
    
    // Lấy thiết bị đầu tiên có wifi_ssid
    let wifiFound = false;
    for (const deviceId in devicesData) {
        const device = devicesData[deviceId];
        if (device && device.wifi_ssid) {
            updateStatus('wifi-status', 'success', `WiFi: ${device.wifi_ssid}`);
            wifiFound = true;
            break;
        }
    }
    
    if (!wifiFound) {
        updateStatus('wifi-status', 'warning', 'WiFi: Không kết nối');
    }
}

// Hàm render 
function renderGrid(data) {
    const grid = document.getElementById('device-grid');
    const addBtn = document.getElementById('btn-open-modal');

    // Xóa card cũ, giữ lại nút Add
    const cards = grid.querySelectorAll('.card:not(#btn-open-modal)');
    cards.forEach(card => card.remove());

    Object.keys(data).forEach(deviceId => {
        const device = data[deviceId];
        if (!device || !device.name) return;


        const card = document.createElement('div');
        card.className = 'card';

        // Header
        const header = document.createElement('div');
        header.className = 'card-header';
        const headerLeft = document.createElement('div');
        const titleDiv = document.createElement('div');
        titleDiv.className = 'card-title';
        titleDiv.textContent = device.name;
        const idSpan = document.createElement('span');
        idSpan.className = 'device-id';
        idSpan.textContent = deviceId;
        headerLeft.appendChild(titleDiv);
        headerLeft.appendChild(idSpan);
        const wifiSpan = document.createElement('span');
        wifiSpan.style.fontSize = '0.85rem';
        wifiSpan.style.color = '#6b7280';
        wifiSpan.innerHTML = '<i class="fa-solid fa-wifi" style="margin-right: 4px;"></i>' + (device.wifi_ssid || 'Chưa kết nối');
        header.appendChild(headerLeft);
        header.appendChild(wifiSpan);

        // Status row
        const statusRow = document.createElement('div');
        statusRow.style.marginBottom = '10px';
        const statusDot = document.createElement('span');
        statusDot.className = 'status-dot';
        const isActive = !!device.active;
        const statusColor = isActive ? '#10b981' : '#9ca3af';
        statusDot.style.background = statusColor;
        const statusText = document.createElement('span');
        statusText.className = 'status-text';
        statusText.style.color = statusColor;
        statusText.textContent = isActive ? `Đang đo (${device.interval || 30}s)` : 'Đã tắt';
        statusRow.appendChild(statusDot);
        statusRow.appendChild(statusText);

        // Metrics
        const metrics = document.createElement('div');
        metrics.className = 'metrics';

        const makeMetric = (label, value) => {
            const item = document.createElement('div');
            item.className = 'metric-item';
            const lbl = document.createElement('span'); lbl.className = 'metric-label'; lbl.textContent = label;
            const val = document.createElement('span'); val.className = 'metric-value'; val.textContent = value;
            item.appendChild(lbl); item.appendChild(val);
            return item;
        };

        metrics.appendChild(makeMetric('NHIỆT ĐỘ', (device.temp !== undefined ? device.temp : '--') + '°C'));
        metrics.appendChild(makeMetric('ĐỘ ẨM', (device.humid !== undefined ? device.humid : '--') + '%'));
        metrics.appendChild(makeMetric('ÁNH SÁNG', (device.lux !== undefined ? device.lux : '--') + ' Lux'));

        // Actions
        const actions = document.createElement('div');
        actions.className = 'card-actions';

        const btnEdit = document.createElement('button');
        btnEdit.className = 'btn-sm';
        btnEdit.textContent = 'Sửa';
        btnEdit.addEventListener('click', () => window.triggerEdit(deviceId, device.name, device.interval || 30));

        const btnPower = document.createElement('button');
        const powerClass = isActive ? 'btn-warning' : 'btn-success';
        btnPower.className = `btn-sm ${powerClass}`;
        btnPower.innerHTML = isActive ? '<i class="fa-solid fa-power-off"></i> Tắt' : '<i class="fa-solid fa-play"></i> Bật';
        btnPower.addEventListener('click', () => window.toggleDevice(deviceId, isActive));

        actions.appendChild(btnEdit);
        actions.appendChild(btnPower);

        // Compose card
        card.appendChild(header);
        card.appendChild(statusRow);
        card.appendChild(metrics);
        card.appendChild(actions);

        grid.insertBefore(card, addBtn);
    });
}

// --- HÀM XỬ LÝ SỬA & XÓA ---
let currentEditId = null;
// 1. Hàm được gọi khi nhấn nút "Sửa" trên Card
window.triggerEdit = (id, currentName, currentInterval) => {
    currentEditId = id; // Lưu ID vào biến toàn cục

    // Điền dữ liệu cũ vào form
    document.getElementById('edit-dev-id').value = id;
    document.getElementById('edit-dev-name').value = currentName;
    document.getElementById('edit-dev-interval').value = currentInterval;

    // Hiện Modal Sửa
    document.getElementById('edit-modal').style.display = 'block';
};


// Setup logic cho Modal Sửa (gọi hàm này trong DOMContentLoaded)
function setupEditModal() {
    const editModal = document.getElementById('edit-modal');
    const editForm = document.getElementById('edit-form');
    const closeBtn = document.querySelector('.closeBtn');
    const deleteBtn = document.getElementById('btn-delete-device');

    // Đóng modal khi nhấn X
    if (closeBtn) {
        closeBtn.onclick = () => {
            editModal.style.display = "none";
            currentEditId = null;
        };
    }

    // Xử lý LƯU (Cập nhật tên)
    if (editForm) {
        editForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const newName = document.getElementById('edit-dev-name').value;
            const newInterval = parseInt(document.getElementById('edit-dev-interval').value);

            if (currentEditId && newName && newInterval) {
                try {
                    // Cập nhật lên Firebase
                    await update(ref(db, `devices/${currentEditId}`), {
                        name: newName,
                        interval: newInterval
                    });
                    
                    // Gửi lệnh MQTT để thay đổi chu kỳ đo ngay lập tức
                    sendCommand(currentEditId, 'INTERVAL', newInterval);
                    
                    alert("Cập nhật thành công!");
                    editModal.style.display = "none";
                } catch (err) {
                    alert("Lỗi cập nhật: " + err.message);
                }
            }
        });
    }

    // Xử lý XÓA (Xóa khỏi Firebase)
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
            if (!currentEditId) return;

            const confirmMsg = `CẢNH BÁO: Bạn có chắc chắn muốn xóa thiết bị [${currentEditId}]?\nDữ liệu sẽ bị xóa VĨNH VIỄN khỏi hệ thống.`;
            if (confirm(confirmMsg)) {
                try {
                    // Xóa node trên Firebase
                    await remove(ref(db, `devices/${currentEditId}`));

                    alert("Đã xóa thiết bị thành công!");
                    editModal.style.display = "none";
                    currentEditId = null;
                    // UI sẽ tự cập nhật nhờ hàm onValue lắng nghe Firebase
                } catch (err) {
                    alert("Lỗi xóa: " + err.message);
                }
            }
        });
    }

    // Đóng modal khi click ra ngoài vùng trắng
    window.addEventListener('click', (e) => {
        if (e.target == editModal) {
            editModal.style.display = "none";
        }
    });
}


// --- MODAL & SWITCH ---
function setupModal() {
    const modal = document.getElementById('add-modal');
    const btn = document.getElementById('btn-open-modal');
    const span = document.querySelector('.close');
    const form = document.getElementById('add-form');


    if (btn) btn.onclick = () => modal.style.display = "block";
    if (span) span.onclick = () => modal.style.display = "none";
    window.addEventListener('click', (e) => { if (e.target == modal) modal.style.display = "none"; });

    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('dev-name').value;
            const id = document.getElementById('dev-id').value;
            // Lấy giá trị chu kỳ từ form thêm mới
            const interval = parseInt(document.getElementById('dev-interval').value) || 30;

            const deviceConfig = {
                name: name,
                active: true,
                mode: 'periodic', // Mặc định là chế độ tự động đo
                interval: interval // Lưu chu kỳ vào Firebase
            };

            try {
                // Lưu vào Firebase
                await update(ref(db, `devices/${id}`), deviceConfig);
                
                // Subscribe MQTT cho device mới
                subscribeDevice(id);
                
                // Gửi lệnh START qua MQTT để kích hoạt device
                sendCommand(id, 'START');
                
                alert("Thêm thiết bị thành công!");
                modal.style.display = "none";
                form.reset();
            } catch (err) {
                alert("Lỗi: " + err.message);
            }
        });
    }
}

function setupMasterSwitch() {
    const btn = document.getElementById('master-switch');
    if (!btn) return;

    // 1. Xử lý khi nhấn nút (DÙNG MQTT)
    btn.addEventListener('click', async () => {
        // Kiểm tra xem nút đang ở trạng thái nào (dựa vào class)
        // Nếu đang có class 'is-on' nghĩa là hệ thống đang chạy -> Cần TẮT (false)
        const isSystemRunning = btn.classList.contains('is-on');
        const targetState = !isSystemRunning; // Đảo ngược trạng thái mong muốn

        try {
            // Lấy danh sách tất cả thiết bị từ Firebase về
            const snapshot = await get(ref(db, 'devices'));

            if (snapshot.exists()) {
                const devices = snapshot.val();
                const updates = {};
                const cmd = targetState ? 'START' : 'STOP';

                // Gửi lệnh MQTT cho TẤT CẢ thiết bị
                Object.keys(devices).forEach(key => {
                    sendCommand(key, cmd);
                    
                    // Nếu tắt hệ thống, tắt luôn các thiết bị con
                    if (!targetState) {
                        sendCommand(key, 'FAN', '0');
                        sendCommand(key, 'LAMP', '0');
                        sendCommand(key, 'AC', '0');
                    }
                    
                    // Cập nhật Firebase để đồng bộ UI
                    updates[`devices/${key}/active`] = targetState;
                    if (!targetState) {
                        updates[`devices/${key}/fan_active`] = false;
                        updates[`devices/${key}/lamp_active`] = false;
                        updates[`devices/${key}/ac_active`] = false;
                    }
                });

                // Gửi 1 lệnh duy nhất lên Firebase (Atomic Update)
                await update(ref(db), updates);

                // Cập nhật giao diện nút ngay lập tức
                updateMasterButtonUI(targetState);
            }
        } catch (err) {
            alert("Lỗi thao tác hệ thống: " + err.message);
        }
    });

    // 2. Hàm cập nhật giao diện nút Master
    function updateMasterButtonUI(isOn) {
        if (isOn) {
            // Trạng thái: Hệ thống đang BẬT -> Hiện nút để TẮT
            btn.className = 'master-btn is-on';
            btn.innerHTML = '<i class="fa-solid fa-power-off"></i> <span>TẮT TOÀN BỘ HỆ THỐNG</span>';
            btn.style.backgroundColor = '#dc2626'; // Đỏ
        } else {
            // Trạng thái: Hệ thống đang TẮT -> Hiện nút để BẬT LẠI
            btn.className = 'master-btn is-off';
            btn.innerHTML = '<i class="fa-solid fa-play"></i> <span>BẬT LẠI HỆ THỐNG</span>';
            btn.style.backgroundColor = '#10b981'; // Xanh lá
        }
    }

    // 3. (Tùy chọn) Kiểm tra trạng thái ban đầu khi tải trang
    // Đoạn này giúp nút hiển thị đúng trạng thái thực tế khi vừa vào web
    get(ref(db, 'devices')).then(snapshot => {
        if (snapshot.exists()) {
            const devices = snapshot.val();
            // Nếu tìm thấy ít nhất 1 thiết bị đang chạy -> Coi như hệ thống đang bật
            const isAnyOn = Object.values(devices).some(d => d.active === true);
            updateMasterButtonUI(isAnyOn);
        }
    });
}

function updateStatus(id, type, text) {
    const el = document.getElementById(id);
    if (el) {
        el.className = `badge ${type}`;
        el.innerText = text;
    }
}

// Hàm Bật/Tắt thiết bị từ xa (DÙNG MQTT)
window.toggleDevice = async (id, currentStatus) => {
    try {
        // Đảo ngược trạng thái hiện tại (Đang bật -> tắt, Đang tắt -> bật)
        const newStatus = !currentStatus;

        // Gửi lệnh qua MQTT
        const cmd = newStatus ? 'START' : 'STOP';
        const success = sendCommand(id, cmd);
        
        if (!success) {
            alert("Không thể gửi lệnh qua MQTT!");
            return;
        }

        // Cập nhật trạng thái vào Firebase (để đồng bộ UI)
        const updates = {
            active: newStatus
        };

        // Nếu hành động là TẮT NGUỒN thì tắt luôn toàn bộ các công tắc con
        if (newStatus === false) {
            updates.fan_active = false;    // Tắt quạt
            updates.lamp_active = false;   // Tắt đèn
            updates.ac_active = false;     // Tắt điều hòa
            
            // Gửi lệnh tắt các thiết bị con qua MQTT
            sendCommand(id, 'FAN', '0');
            sendCommand(id, 'LAMP', '0');
            sendCommand(id, 'AC', '0');
        }

        // Cập nhật Firebase để đồng bộ UI
        await update(ref(db, `devices/${id}`), updates);

    } catch (err) {
        alert("Lỗi cập nhật trạng thái: " + err.message);
    }
};

//  Hàm chuyển đổi Tab (Dashboard <-> Báo cáo)
window.switchTab = function (tabName) {
    const dashboardGrid = document.getElementById('device-grid');
    const addBtn = document.getElementById('btn-open-modal');
    const reportTitleView = document.getElementById('report-view');
    const reportList = document.getElementById('report-list');
    const reportDetail = document.getElementById('report-detail');
    const masterBtn = document.getElementById('master-switch');
    const mainHeaderTitle = document.querySelector('header h1');
    const settingView = document.getElementById('setting-view');
    const exportView = document.getElementById('export-view');

    document.querySelectorAll('.sidebar .menu a').forEach(a => a.classList.remove('active'));

    if (dashboardGrid) dashboardGrid.style.display = 'none';
    if (addBtn) addBtn.style.display = 'none';
    if (reportTitleView) reportTitleView.style.display = 'none';
    if (reportList) reportList.style.display = 'none';
    if (reportDetail) reportDetail.style.display = 'none';
    if (settingView) settingView.style.display = 'none';
    if (exportView) exportView.style.display = 'none';

    if (tabName === 'dashboard') {
        if (dashboardGrid) dashboardGrid.style.display = 'grid';
        if (addBtn) addBtn.style.display = 'block';
        if (masterBtn) masterBtn.style.display = 'flex';
        if (mainHeaderTitle) mainHeaderTitle.innerText = 'Quản lý các phòng';
        updateActiveMenu(0);

    } else if (tabName === 'report') {
        if (reportTitleView) reportTitleView.style.display = 'block';
        if (reportList) reportList.style.display = 'grid';
        if (masterBtn) masterBtn.style.display = 'none';
        if (mainHeaderTitle) mainHeaderTitle.innerText = 'Báo Cáo & Phân Tích';

        if (typeof renderReportList === 'function') renderReportList();

        updateActiveMenu(1);
    } else if (tabName === 'setting') {
        if (settingView) settingView.style.display = 'block';
        if (masterBtn) masterBtn.style.display = 'none';
        if (mainHeaderTitle) mainHeaderTitle.innerText = 'Cấu Hình Hệ Thống';

        loadSettingsToForm();
        updateActiveMenu(3);
    } else if (tabName === 'export') {
        if (exportView) exportView.style.display = 'block';
        if (masterBtn) masterBtn.style.display = 'none';
        if (mainHeaderTitle) mainHeaderTitle.innerText = 'Dữ Liệu Tổng Hợp';
        updateActiveMenu(2);
    }
}

// Hàm phụ để đổi màu cho menu sidebar
function updateActiveMenu(index) {
    const links = document.querySelectorAll('.sidebar .menu a');
    links.forEach(link => link.classList.remove('active'));
    if (links[index]) links[index].classList.add('active');
}

// --- 3. LOGIC BIỂU ĐỒ & BÁO CÁO (QUAN TRỌNG) ---

// Render danh sách phòng ở trang Báo Cáo với REALTIME UPDATE
function renderReportList() {
    const grid = document.getElementById('report-list');
    if (!grid) return;
    grid.innerHTML = '<p style="color:#666">Đang tải dữ liệu...</p>';

    // SỬA: Dùng onValue thay vì get để cập nhật realtime
    onValue(ref(db, 'devices'), (snapshot) => {
        grid.innerHTML = '';

        if (snapshot.exists()) {
            const data = snapshot.val();
            Object.keys(data).forEach(deviceId => {
                const device = data[deviceId];
                if (!device || !device.name) return;

                const card = document.createElement('div');
                card.className = 'report-card';
                card.setAttribute('data-device-id', deviceId); // Thêm ID để dễ update

                // Header
                const header = document.createElement('div');
                header.className = 'card-header';
                const headerLeft = document.createElement('div');
                const titleDiv = document.createElement('div');
                titleDiv.className = 'card-title';
                titleDiv.textContent = device.name;
                const idSpan = document.createElement('span');
                idSpan.className = 'device-id';
                idSpan.textContent = deviceId;
                headerLeft.appendChild(titleDiv);
                headerLeft.appendChild(idSpan);
                const wifiSpan = document.createElement('span');
                wifiSpan.style.fontSize = '0.85rem';
                wifiSpan.style.color = '#6b7280';
                wifiSpan.innerHTML = '<i class="fa-solid fa-wifi" style="margin-right: 4px;"></i>' + (device.wifi_ssid || 'Chưa kết nối');
                header.appendChild(headerLeft);
                header.appendChild(wifiSpan);

                // Status row
                const statusRow = document.createElement('div');
                statusRow.style.marginBottom = '10px';
                const statusDot = document.createElement('span');
                statusDot.className = 'status-dot';
                const isActive = !!device.active;
                const statusColor = isActive ? '#10b981' : '#9ca3af';
                statusDot.style.background = statusColor;
                const statusText = document.createElement('span');
                statusText.className = 'status-text';
                statusText.style.color = statusColor;
                statusText.textContent = isActive ? `Đang đo (${device.interval || 30}s)` : 'Đã tắt';
                statusRow.appendChild(statusDot);
                statusRow.appendChild(statusText);

                // Metrics
                const metrics = document.createElement('div');
                metrics.className = 'metrics';

                const makeMetric = (label, value) => {
                    const item = document.createElement('div');
                    item.className = 'metric-item';
                    const lbl = document.createElement('span');
                    lbl.className = 'metric-label';
                    lbl.textContent = label;
                    const val = document.createElement('span');
                    val.className = 'metric-value';
                    val.textContent = value;
                    item.appendChild(lbl);
                    item.appendChild(val);
                    return item;
                };

                metrics.appendChild(makeMetric('NHIỆT ĐỘ', (device.temp !== undefined ? device.temp : '--') + '°C'));
                metrics.appendChild(makeMetric('ĐỘ ẨM', (device.humid !== undefined ? device.humid : '--') + '%'));
                metrics.appendChild(makeMetric('ÁNH SÁNG', (device.lux !== undefined ? device.lux : '--') + ' Lux'));

                // Actions
                const actions = document.createElement('div');
                actions.className = 'card-actions';

                const btnDetail = document.createElement('button');
                btnDetail.className = 'btn-sm btn-primary';
                btnDetail.style.width = '100%';
                btnDetail.innerHTML = '<i class="fa-solid fa-chart-line"></i> Xem Chi Tiết';
                btnDetail.addEventListener('click', () => {
                    showChart(deviceId, device.name);
                });

                actions.appendChild(btnDetail);

                // Compose card
                card.appendChild(header);
                card.appendChild(statusRow);
                card.appendChild(metrics);
                card.appendChild(actions);

                // Add click listener to card AFTER all elements are appended
                // Check if click is on button or button child to prevent opening chart
                card.addEventListener('click', (e) => {
                    // If clicked element or its parent is a button, don't open chart
                    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) {
                        return;
                    }
                    showChart(deviceId, device.name);
                });

                grid.appendChild(card);
            });
        } else {
            grid.innerHTML = '<p>Chưa có thiết bị nào.</p>';
        }
    }, (err) => {
        console.error(err);
        grid.innerHTML = '<p style="color:#ef4444">Lỗi tải dữ liệu</p>';
    });
}

// Hàm chọn loại biểu đồ (Gắn vào window để HTML gọi)
window.selectChartType = (type) => {
    console.log("Click chọn biểu đồ:", type);
    currentChartType = type;
    updateChartUIActive(type);
    drawChartNewLogic();
};

function updateChartUIActive(type) {
    const ids = ['btn-chart-temp', 'btn-chart-humid', 'btn-chart-light'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active-chart');
    });

    if (type === 'temp') document.getElementById('btn-chart-temp')?.classList.add('active-chart');
    if (type === 'humid') document.getElementById('btn-chart-humid')?.classList.add('active-chart');
    if (type === 'light') document.getElementById('btn-chart-light')?.classList.add('active-chart');
}

// Hàm hiển thị Chi tiết & Lấy dữ liệu
async function showChart(deviceId, deviceName) {
    console.log("Mở biểu đồ:", deviceName);
    currentReportDeviceId = deviceId;

    // 1. Reset & Chuẩn bị giao diện
    updateChartUIActive(null); // Reset nút bấm
    document.getElementById('report-detail').style.display = 'block';

    // Cập nhật tên phòng
    const title = document.getElementById('report-title'); // Hoặc id là 'chart-device-name' tùy HTML của bạn
    if (title) title.innerText = `Phòng: ${deviceName}`;

    // Cuộn xuống
    document.getElementById('report-detail').scrollIntoView({ behavior: 'smooth' });

    // 2. Tải lịch sử CŨ (Chỉ tải 1 lần duy nhất để làm nền)
    cachedHistoryData = { labels: [], temps: [], humids: [], lights: [] };

    try {
        const historyRef = query(ref(db, `history/${deviceId}`), limitToLast(20));
        const historySnapshot = await get(historyRef); // Dùng get thay vì onValue

        if (historySnapshot.exists()) {
            historySnapshot.forEach(child => {
                const val = child.val();
                const timeStr = new Date(val.last_update).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                cachedHistoryData.labels.push(timeStr);
                cachedHistoryData.temps.push(val.temp);
                cachedHistoryData.humids.push(val.humid);
                cachedHistoryData.lights.push(val.lux);
            });
        }
    } catch (e) {
        console.error("Lỗi tải lịch sử:", e);
    }

    // Vẽ biểu đồ lần đầu (với dữ liệu lịch sử vừa tải)
    drawChartNewLogic();

    // 3. LẮNG NGHE REALTIME (Quan trọng nhất)
    // Nghe đúng cái chỗ mà 3 ô số liệu đang nghe
    let lastSensorData = { temp: null, humid: null, light: null }; // Track previous sensor values

    onValue(ref(db, `devices/${deviceId}`), (snapshot) => {
        const data = snapshot.val();
        if (!data) return;

        // Nguồn
        const elPower = document.getElementById('detail-power-status');
        const elBoxPower = document.getElementById('stat-power-box');
        if (elPower && elBoxPower) {
            if (data.active) {
                elPower.innerText = "ĐANG BẬT"; elPower.style.color = "#10b981"; elBoxPower.style.borderLeftColor = "#10b981";
                elBoxPower.onclick = () => window.toggleDevice(deviceId, true);
            } else {
                elPower.innerText = "ĐÃ TẮT"; elPower.style.color = "#ef4444"; elBoxPower.style.borderLeftColor = "#ef4444";
                elBoxPower.onclick = () => window.toggleDevice(deviceId, false);
            }
        }
        // 3 thông số
        if (document.getElementById('detail-temp')) document.getElementById('detail-temp').innerText = (data.temp || '--') + ' °C';
        if (document.getElementById('detail-humid')) document.getElementById('detail-humid').innerText = (data.humid || '--') + ' %';
        if (document.getElementById('detail-light')) document.getElementById('detail-light').innerText = (data.lux || '--') + ' Lux';

        // Switch
        if (document.getElementById('toggle-fan')) document.getElementById('toggle-fan').checked = (data.fan_active === true);
        if (document.getElementById('toggle-lamp')) document.getElementById('toggle-lamp').checked = (data.lamp_active === true);
        if (document.getElementById('toggle-ac')) document.getElementById('toggle-ac').checked = (data.ac_active === true);


        // --- B. CẬP NHẬT BIỂU ĐỒ - CHỈ KHI DỮ LIỆU SENSOR THAY ĐỔI ---
        // Check if sensor data actually changed (not just toggle changes)
        const sensorChanged =
            lastSensorData.temp !== data.temp ||
            lastSensorData.humid !== data.humid ||
            lastSensorData.light !== data.lux;

        if (sensorChanged && data.temp !== undefined && data.humid !== undefined && data.lux !== undefined) {
            // Update last known sensor values
            lastSensorData = { temp: data.temp, humid: data.humid, light: data.lux };

            // Lấy giờ hiện tại
            const now = new Date();
            const timeLabel = now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');

            // Đẩy số liệu mới đang nhảy vào mảng biểu đồ
            cachedHistoryData.labels.push(timeLabel);
            cachedHistoryData.temps.push(data.temp || 0);
            cachedHistoryData.humids.push(data.humid || 0);
            cachedHistoryData.lights.push(data.lux || 0);

            // Cắt bớt nếu dài quá (giữ 20 điểm)
            if (cachedHistoryData.labels.length > 20) {
                cachedHistoryData.labels.shift();
                cachedHistoryData.temps.shift();
                cachedHistoryData.humids.shift();
                cachedHistoryData.lights.shift();
            }

            // Gọi hàm cập nhật biểu đồ (Update nhẹ)
            updateChartRealtime();
        }
    });
}

function updateChartRealtime() {
    // Nếu chưa có biểu đồ hoặc chưa chọn loại dữ liệu thì thôi
    if (!myChartInstance || !currentChartType) return;

    // Cập nhật trục thời gian
    myChartInstance.data.labels = cachedHistoryData.labels;

    // Cập nhật đường kẻ tùy theo tab đang chọn
    if (currentChartType === 'temp') {
        myChartInstance.data.datasets[0].data = cachedHistoryData.temps;
    } else if (currentChartType === 'humid') {
        myChartInstance.data.datasets[0].data = cachedHistoryData.humids;
    } else if (currentChartType === 'light') {
        myChartInstance.data.datasets[0].data = cachedHistoryData.lights;
    }

    // Vẽ lại (chế độ 'none' để không chạy lại animation từ đầu -> mượt)
    myChartInstance.update('none');
}


// Hàm vẽ biểu đồ (Safe Mode)
function drawChartNewLogic() {
    const canvas = document.getElementById('myChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Hủy biểu đồ cũ nếu có
    if (myChartInstance) {
        myChartInstance.destroy();
        myChartInstance = null;
    }

    let labelsToDraw = cachedHistoryData.labels;
    // Nếu chưa có dữ liệu nào thì tạo mảng rỗng để không lỗi
    if (!labelsToDraw || labelsToDraw.length === 0) {
        labelsToDraw = ["--", "--", "--", "--", "--"];
    }

    let dataToDraw = [];
    let labelText = "Chọn thông số";
    let color = "#ccc";
    let unit = "";

    // Nếu chưa chọn gì thì vẽ đường 0
    if (!currentChartType) {
        dataToDraw = new Array(labelsToDraw.length).fill(0);
    } else {
        // Lấy toàn bộ mảng lịch sử hiện có ra vẽ
        if (currentChartType === 'temp') {
            dataToDraw = cachedHistoryData.temps;
            labelText = "Nhiệt Độ (°C)"; color = "#f97316"; unit = "°C";
        } else if (currentChartType === 'humid') {
            dataToDraw = cachedHistoryData.humids;
            labelText = "Độ Ẩm (%)"; color = "#3b82f6"; unit = "%";
        } else if (currentChartType === 'light') {
            dataToDraw = cachedHistoryData.lights;
            labelText = "Ánh Sáng (Lux)"; color = "#eab308"; unit = " Lux";
        }

        // Fix lỗi nếu mảng data ngắn hơn mảng label (do mới khởi tạo)
        if (dataToDraw.length < labelsToDraw.length) {
            const diff = labelsToDraw.length - dataToDraw.length;
            for (let i = 0; i < diff; i++) dataToDraw.push(0);
        }
    }

    myChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labelsToDraw,
            datasets: [{
                label: labelText,
                data: dataToDraw,
                borderColor: color,
                backgroundColor: color + "33",
                tension: 0.4,
                fill: true,
                pointRadius: currentChartType ? 4 : 0,
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: !!unit, text: unit }
                },
                x: { display: false } // Ẩn trục X
            }
        }
    });
}

// Hàm xử lý 3 nút gạt Quick Control (DÙNG MQTT)
window.toggleFeature = async (feature) => {
    if (!currentReportDeviceId) return;

    // Lấy trạng thái hiện tại của checkbox
    let isChecked = false;
    let dbKey = '';
    let mqttCmd = '';

    if (feature === 'fan') {
        isChecked = document.getElementById('toggle-fan').checked;
        dbKey = 'fan_active';
        mqttCmd = 'FAN';
    } else if (feature === 'lamp') {
        isChecked = document.getElementById('toggle-lamp').checked;
        dbKey = 'lamp_active';
        mqttCmd = 'LAMP';
    } else if (feature === 'ac') {
        isChecked = document.getElementById('toggle-ac').checked;
        dbKey = 'ac_active';
        mqttCmd = 'AC';
    }

    try {
        // Gửi lệnh qua MQTT
        const mqttVal = isChecked ? '1' : '0';
        const success = sendCommand(currentReportDeviceId, mqttCmd, mqttVal);
        
        if (!success) {
            // Nếu MQTT fail, trả lại trạng thái cũ
            document.getElementById(`toggle-${feature}`).checked = !isChecked;
            alert("Không thể gửi lệnh qua MQTT!");
            return;
        }
        
        // Cập nhật Firebase để đồng bộ UI
        await update(ref(db, `devices/${currentReportDeviceId}`), {
            [dbKey]: isChecked
        });
        
    } catch (err) {
        console.error("Lỗi toggle:", err);
        // Nếu lỗi thì trả lại trạng thái cũ cho checkbox
        document.getElementById(`toggle-${feature}`).checked = !isChecked;
    }
};
window.closeReportDetail = () => {
    document.getElementById('report-detail').style.display = 'none';
};

// Đóng modal báo cáo khi click ra vùng ngoài (overlay)
window.addEventListener('click', (e) => {
    const reportModal = document.getElementById('report-detail');
    if (e.target === reportModal) {
        reportModal.style.display = 'none';
    }
});

// --- LOGIC XUẤT DỮ LIỆU (History Table) ---

window.fetchAllHistoryData = async function () {
    const tbody = document.getElementById('table-body');
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center">Đang tải dữ liệu từ Firebase...</td></tr>';

    try {
        // BƯỚC 1: Lấy danh sách thiết bị để biết ID nào tên là gì
        // (Vì trong history chỉ lưu ID chứ không lưu tên phòng)
        const devicesSnap = await get(ref(db, 'devices'));
        const devicesMap = {}; // Tạo từ điển: ID -> Tên Phòng

        if (devicesSnap.exists()) {
            const devices = devicesSnap.val();
            Object.keys(devices).forEach(key => {
                devicesMap[key] = devices[key].name;
            });
        }

        // BƯỚC 2: Lấy dữ liệu lịch sử
        // Lưu ý: Lấy toàn bộ history có thể rất nặng.
        // Ở đây tôi ví dụ lấy 50 dòng cuối của MỖI thiết bị để demo cho nhanh.

        let allRows = []; // Mảng chứa tất cả dòng dữ liệu

        // Duyệt qua từng ID thiết bị để lấy lịch sử
        const deviceIds = Object.keys(devicesMap);

        for (const devId of deviceIds) {
            const devName = devicesMap[devId];

            // Query lấy 50 dòng cuối cùng của thiết bị này
            const historyQuery = query(ref(db, `history/${devId}`), limitToLast(50));
            const historySnap = await get(historyQuery);

            if (historySnap.exists()) {
                historySnap.forEach(child => {
                    const val = child.val();
                    // Đẩy vào mảng chung
                    allRows.push({
                        room: devName,
                        time: val.last_update, // Giả sử bạn lưu time dạng timestamp hoặc ISO string
                        temp: val.temp,
                        humid: val.humid,
                        light: val.lux
                    });
                });
            }
        }

        // BƯỚC 3: Sắp xếp lại theo thời gian (Mới nhất lên đầu)
        allRows.sort((a, b) => new Date(b.time) - new Date(a.time));

        // BƯỚC 4: Vẽ lên bảng
        tbody.innerHTML = '';
        if (allRows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center">Không tìm thấy dữ liệu lịch sử.</td></tr>';
            return;
        }

        allRows.forEach((row, index) => {
            // Format lại thời gian cho đẹp
            const dateObj = new Date(row.time);
            const timeStr = dateObj.toLocaleString('vi-VN');

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${index + 1}</td>
                <td style="font-weight: 500; color: var(--primary-color)">${row.room}</td>
                <td>${timeStr}</td>
                <td>${row.temp} °C</td>
                <td>${row.humid} %</td>
                <td>${row.light} Lux</td>
            `;
            tbody.appendChild(tr);
        });

    } catch (error) {
        console.error("Lỗi lấy dữ liệu:", error);
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:red">Lỗi: ${error.message}</td></tr>`;
    }
};

// Hàm phụ: Xuất ra Excel (Đơn giản)
window.exportTableToExcel = function () {
    const table = document.querySelector(".data-table");
    let html = table.outerHTML;

    // Tạo link tải về
    const url = 'data:application/vnd.ms-excel,' + escape(html); // Tạo Blob Excel
    const link = document.createElement("a");
    link.href = url;
    link.download = "Du_Lieu_IoT_" + new Date().toISOString().slice(0, 10) + ".xls";
    link.click();
}

// --- LOGIC CÀI ĐẶT MQTT ---

// 1. Hàm lưu cấu hình MQTT khi bấm nút Save
window.saveMQTTSettings = function (event) {
    event.preventDefault();

    const config = {
        host: document.getElementById('cfg-mqtt-host').value.trim(),
        ip: document.getElementById('cfg-mqtt-ip').value.trim()
    };

    // Validate
    if (!config.host) {
        alert("Vui lòng nhập MQTT Broker Host!");
        return;
    }
    if (!config.ip) {
        alert("Vui lòng nhập IP!");
        return;
    }

    // Lưu vào localStorage
    localStorage.setItem('mqtt_config', JSON.stringify(config));

    alert("Đã lưu cấu hình!");
};

// 2. Hàm điền dữ liệu MQTT cũ vào form khi mở tab
function loadSettingsToForm() {
    // Cập nhật ngày giờ
    updateDateTime();
    setInterval(updateDateTime, 1000); // Cập nhật mỗi giây
    
    // Load MQTT Host
    const savedString = localStorage.getItem('mqtt_config');
    if (savedString) {
        try {
            const config = JSON.parse(savedString);
            if (config.host) {
                document.getElementById('display-mqtt-host').textContent = config.host;
            }
        } catch (e) {
            console.error("Lỗi load cấu hình MQTT:", e);
        }
    }
    
    // Load thông tin thiết bị vào bảng
    loadDeviceInfoTable();
}

// Hàm cập nhật ngày giờ
function updateDateTime() {
    const now = new Date();
    const days = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
    const dayName = days[now.getDay()];
    const date = now.getDate().toString().padStart(2, '0');
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const year = now.getFullYear();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    
    const dateElement = document.getElementById('current-date');
    const timeElement = document.getElementById('current-time');
    
    if (dateElement) {
        dateElement.textContent = `${dayName}, ${date}/${month}/${year}`;
    }
    if (timeElement) {
        timeElement.textContent = `${hours}:${minutes}`;
    }
}

// Hàm load thông tin thiết bị vào bảng
async function loadDeviceInfoTable() {
    const tableBody = document.getElementById('device-info-table');
    if (!tableBody) return;
    
    try {
        const snapshot = await get(ref(db, 'devices'));
        
        if (!snapshot.exists()) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="3" style="padding: 20px; text-align: center; color: #9ca3af;">
                        <i class="fa-solid fa-inbox"></i> Chưa có thiết bị nào
                    </td>
                </tr>
            `;
            return;
        }
        
        const devices = snapshot.val();
        let html = '';
        
        for (const [id, data] of Object.entries(devices)) {
            const name = data.name || 'Chưa đặt tên';
            const ip = data.ip || '192.168.1.22'; // IP mặc định
            
            html += `
                <tr style="border-bottom: 1px solid #e5e7eb;">
                    <td style="padding: 12px; border: 1px solid #e5e7eb;">
                        <i class="fa-solid fa-door-open" style="color: #3b82f6; margin-right: 8px;"></i>
                        ${name}
                    </td>
                    <td style="padding: 12px; border: 1px solid #e5e7eb; font-family: monospace; color: #6b7280;">
                        ${id}
                    </td>
                    <td style="padding: 12px; border: 1px solid #e5e7eb; font-family: monospace; color: #059669;">
                        ${ip}
                    </td>
                </tr>
            `;
        }
        
        tableBody.innerHTML = html;
        
    } catch (error) {
        console.error('Error loading device info:', error);
        tableBody.innerHTML = `
            <tr>
                <td colspan="3" style="padding: 20px; text-align: center; color: #ef4444;">
                    <i class="fa-solid fa-triangle-exclamation"></i> Lỗi tải dữ liệu: ${error.message}
                </td>
            </tr>
        `;
    }
}

// Hàm Reboot tất cả thiết bị
window.rebootAllDevices = async function() {
    if (!confirm("⚠️ Bạn có chắc muốn REBOOT tất cả thiết bị ESP32?\n\nThiết bị sẽ khởi động lại và mất kết nối trong vài giây.")) {
        return;
    }
    
    if (!isMQTTConnected()) {
        alert("❌ Chưa kết nối MQTT! Không thể gửi lệnh reboot.");
        return;
    }
    
    try {
        const snapshot = await get(ref(db, 'devices'));
        
        if (!snapshot.exists()) {
            alert("Không tìm thấy thiết bị nào!");
            return;
        }
        
        const devices = snapshot.val();
        let count = 0;
        
        // Gửi lệnh reboot cho tất cả thiết bị
        for (const deviceId of Object.keys(devices)) {
            const topic = `SmartHome/${deviceId}/command`;
            commandCounter++;
            
            const rebootPayload = {
                id: "cmd_" + commandCounter.toString().padStart(3, '0'),
                command: "reboot",
                params: {}
            };
            
            const payload = JSON.stringify(rebootPayload);
            const message = new Paho.MQTT.Message(payload);
            message.destinationName = topic;
            
            try {
                mqttClient.send(message);
                console.log(`✅ Sent reboot to ${deviceId}`);
                count++;
            } catch (e) {
                console.error(`❌ Failed to send reboot to ${deviceId}:`, e);
            }
        }
        
        alert(`✅ Đã gửi lệnh REBOOT đến ${count} thiết bị!\n\nCác thiết bị sẽ khởi động lại trong vài giây.`);
        
    } catch (error) {
        console.error('Error rebooting devices:', error);
        alert("❌ Lỗi khi gửi lệnh reboot: " + error.message);
    }
};

// Hàm đồng bộ thời gian cho tất cả thiết bị
window.syncTimeToAllDevices = async function() {
    if (!confirm("🕒 Bạn có chắc muốn cập nhật thời gian cho tất cả thiết bị?\n\nThời gian hiện tại của web sẽ được gửi đến ESP32.")) {
        return;
    }
    
    if (!isMQTTConnected()) {
        alert("❌ Chưa kết nối MQTT! Không thể gửi lệnh.");
        return;
    }
    
    try {
        const snapshot = await get(ref(db, 'devices'));
        
        if (!snapshot.exists()) {
            alert("Không tìm thấy thiết bị nào!");
            return;
        }
        
        const devices = snapshot.val();
        let count = 0;
        let deviceList = [];
        
        // Lấy timestamp hiện tại (Unix timestamp tính bằng giây)
        const currentTimestamp = Math.floor(Date.now() / 1000);
        
        console.log(`📡 Sending timestamp ${currentTimestamp} to ${Object.keys(devices).length} devices...`);
        
        // Gửi lệnh set_timestamp cho tất cả thiết bị
        for (const deviceId of Object.keys(devices)) {
            const topic = `SmartHome/${deviceId}/command`;
            commandCounter++;
            
            const timePayload = {
                id: "cmd_" + commandCounter.toString().padStart(3, '0'),
                command: "set_timestamp",
                params: {
                    timestamp: currentTimestamp
                }
            };
            
            const payload = JSON.stringify(timePayload);
            const message = new Paho.MQTT.Message(payload);
            message.destinationName = topic;
            
            try {
                mqttClient.send(message);
                console.log(`✅ Sent timestamp to [${topic}]:`, payload);
                deviceList.push(deviceId);
                count++;
            } catch (e) {
                console.error(`❌ Failed to send timestamp to ${deviceId}:`, e);
            }
        }
        
        const currentTime = new Date().toLocaleString('vi-VN');
        alert(`✅ Đã gửi thời gian đến ${count} thiết bị!\n\nThiết bị: ${deviceList.join(', ')}\n\nThời gian: ${currentTime}\nTimestamp: ${currentTimestamp}\n\n⚠️ Lưu ý: ESP32 cần đang online và subscribe topic command để nhận được lệnh.`);
        
    } catch (error) {
        console.error('Error syncing time:', error);
        alert("❌ Lỗi khi gửi lệnh đồng bộ thời gian: " + error.message);
    }
};

// Hiển thị modal chỉnh thời gian thủ công
window.showManualTimeModal = function() {
    const modal = document.getElementById('manual-time-modal');
    const dateInput = document.getElementById('manual-date-input');
    const timeInput = document.getElementById('manual-time-input');
    
    if (!modal) return;
    
    // Set giá trị mặc định là thời gian hiện tại
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    
    dateInput.value = dateStr;
    timeInput.value = timeStr;
    
    // Cập nhật preview
    updateManualTimePreview();
    
    // Thêm event listener để cập nhật preview khi thay đổi (chỉ thêm 1 lần)
    dateInput.removeEventListener('change', updateManualTimePreview);
    timeInput.removeEventListener('change', updateManualTimePreview);
    dateInput.addEventListener('change', updateManualTimePreview);
    timeInput.addEventListener('change', updateManualTimePreview);
    
    // Hiển thị modal
    modal.style.display = 'block';
    document.body.style.overflow = 'hidden'; // Ngăn scroll khi modal mở
};

// Đóng modal
window.closeManualTimeModal = function() {
    const modal = document.getElementById('manual-time-modal');
    if (modal) {
        modal.style.display = 'none';
        document.body.style.overflow = ''; // Khôi phục scroll
    }
};

// Cập nhật preview thời gian
function updateManualTimePreview() {
    const dateInput = document.getElementById('manual-date-input');
    const timeInput = document.getElementById('manual-time-input');
    const preview = document.getElementById('manual-time-preview');
    
    if (!dateInput || !timeInput || !preview) return;
    
    if (dateInput.value && timeInput.value) {
        const selectedDate = new Date(dateInput.value + 'T' + timeInput.value);
        const days = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
        const dayName = days[selectedDate.getDay()];
        
        preview.textContent = `${dayName}, ${selectedDate.toLocaleString('vi-VN')}`;
    } else {
        preview.textContent = 'Chưa chọn';
    }
}

// Áp dụng thời gian thủ công
window.applyManualTime = async function() {
    const dateInput = document.getElementById('manual-date-input');
    const timeInput = document.getElementById('manual-time-input');
    
    if (!dateInput.value || !timeInput.value) {
        alert("⚠️ Vui lòng chọn đầy đủ ngày và giờ!");
        return;
    }
    
    if (!isMQTTConnected()) {
        alert("❌ Chưa kết nối MQTT! Không thể gửi lệnh.");
        return;
    }
    
    try {
        // Tạo Date object từ input
        const selectedDateTime = new Date(dateInput.value + 'T' + timeInput.value);
        const manualTimestamp = Math.floor(selectedDateTime.getTime() / 1000);
        
        const snapshot = await get(ref(db, 'devices'));
        
        if (!snapshot.exists()) {
            alert("Không tìm thấy thiết bị nào!");
            return;
        }
        
        const devices = snapshot.val();
        let count = 0;
        let deviceList = [];
        
        console.log(`📡 Sending manual timestamp ${manualTimestamp} to ${Object.keys(devices).length} devices...`);
        
        // Gửi lệnh set_timestamp cho tất cả thiết bị
        for (const deviceId of Object.keys(devices)) {
            const topic = `SmartHome/${deviceId}/command`;
            commandCounter++;
            
            const timePayload = {
                id: "cmd_" + commandCounter.toString().padStart(3, '0'),
                command: "set_timestamp",
                params: {
                    timestamp: manualTimestamp
                }
            };
            
            const payload = JSON.stringify(timePayload);
            const message = new Paho.MQTT.Message(payload);
            message.destinationName = topic;
            
            try {
                mqttClient.send(message);
                console.log(`✅ Sent manual timestamp to [${topic}]:`, payload);
                deviceList.push(deviceId);
                count++;
            } catch (e) {
                console.error(`❌ Failed to send timestamp to ${deviceId}:`, e);
            }
        }
        
        closeManualTimeModal();
        alert(`✅ Đã gửi thời gian thủ công đến ${count} thiết bị!\n\nThiết bị: ${deviceList.join(', ')}\n\nThời gian: ${selectedDateTime.toLocaleString('vi-VN')}\nTimestamp: ${manualTimestamp}`);
        
    } catch (error) {
        console.error('Error applying manual time:', error);
        alert("❌ Lỗi khi gửi thời gian thủ công: " + error.message);
    }
};

// 3. Hàm xóa cấu hình MQTT (Reset)
window.clearMQTTSettings = function () {
    if (confirm("Bạn có chắc muốn xóa cấu hình MQTT?")) {
        localStorage.removeItem('mqtt_config');
        document.getElementById('cfg-mqtt-host').value = '6ceea111b6144c71a57b21faa3553fc6.s1.eu.hivemq.cloud';
        document.getElementById('cfg-mqtt-ip').value = '192.168.1.22';
        alert("Đã reset về giá trị mặc định.");
    }
};

// ============================================================
// WIFI SETUP GUIDE - Hiển thị hướng dẫn kết nối WiFi cho ESP32
// ============================================================
window.showWiFiSetupGuide = function() {
    const guideDiv = document.getElementById('wifi-guide-content');
    
    if (!guideDiv) {
        console.error('wifi-guide-content div not found');
        return;
    }

    // Toggle hiển thị/ẩn
    if (guideDiv.style.display === 'none' || guideDiv.style.display === '') {
        // IP mặc định cho ESP32 khi ở chế độ AP
        const espIP = '192.168.4.1';
        
        // Hiển thị hướng dẫn
        guideDiv.innerHTML = `
            <div style="color: #78350f;">
                <h4 style="margin: 0 0 15px 0; color: #92400e;">
                    <i class="fa-solid fa-circle-info"></i> Các bước cấu hình WiFi cho ESP32
                </h4>
                
                <div style="background: #fef9f3; padding: 12px; border-radius: 6px; margin-bottom: 15px; border: 1px solid #fbbf24;">
                    <strong style="color: #92400e;">Bước 1: Kết nối vào WiFi của ESP32</strong>
                    <ol style="margin: 10px 0 0 20px; padding: 0;">
                        <li style="margin: 5px 0;">Mở danh sách WiFi trên điện thoại/máy tính của bạn</li>
                        <li style="margin: 5px 0;">Tìm và kết nối vào mạng WiFi: <code style="background: white; padding: 2px 6px; border-radius: 3px; color: #c2410c;">ESP32_SmartHome</code></li>
                        <li style="margin: 5px 0;">Password (nếu có): <code style="background: white; padding: 2px 6px; border-radius: 3px; color: #c2410c;">12345678</code></li>
                    </ol>
                </div>

                <div style="background: #fef9f3; padding: 12px; border-radius: 6px; margin-bottom: 15px; border: 1px solid #fbbf24;">
                    <strong style="color: #92400e;">Bước 2: Mở trình duyệt và truy cập</strong>
                    <p style="margin: 10px 0;">
                        Sau khi kết nối WiFi ESP32, mở trình duyệt và truy cập vào:
                    </p>
                    <div style="text-align: center; margin: 10px 0;">
                        <a href="http://${espIP}" target="_blank" 
                           style="display: inline-block; padding: 12px 24px; background: #f59e0b; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 1.1rem;">
                            <i class="fa-solid fa-external-link-alt"></i> http://${espIP}
                        </a>
                    </div>
                    <p style="margin: 10px 0; font-size: 0.9rem; color: #92400e;">
                        <i class="fa-solid fa-lightbulb"></i> Click vào link trên để mở trang cấu hình
                    </p>
                </div>

                <div style="background: #fef9f3; padding: 12px; border-radius: 6px; margin-bottom: 15px; border: 1px solid #fbbf24;">
                    <strong style="color: #92400e;">Bước 3: Nhập thông tin WiFi nhà bạn</strong>
                    <ol style="margin: 10px 0 0 20px; padding: 0;">
                        <li style="margin: 5px 0;">Chọn tên WiFi nhà bạn từ danh sách (hoặc nhập thủ công)</li>
                        <li style="margin: 5px 0;">Nhập mật khẩu WiFi</li>
                        <li style="margin: 5px 0;">Click <strong>"Lưu"</strong> hoặc <strong>"Connect"</strong></li>
                        <li style="margin: 5px 0;">Đợi ESP32 khởi động lại và kết nối vào WiFi nhà bạn</li>
                    </ol>
                </div>

                <div style="background: #dcfce7; padding: 12px; border-radius: 6px; border: 1px solid #86efac;">
                    <strong style="color: #166534;">
                        <i class="fa-solid fa-check-circle"></i> Sau khi cấu hình xong
                    </strong>
                    <p style="margin: 10px 0 0 0; color: #166534;">
                        ESP32 sẽ tự động kết nối vào WiFi nhà bạn. Sau đó bạn có thể kết nối lại WiFi nhà và sử dụng hệ thống bình thường.
                    </p>
                </div>

                <div style="margin-top: 15px; padding: 10px; background: #fee2e2; border-left: 4px solid #ef4444; border-radius: 4px;">
                    <strong style="color: #991b1b;">
                        <i class="fa-solid fa-exclamation-triangle"></i> Lưu ý
                    </strong>
                    <ul style="margin: 8px 0 0 20px; padding: 0; color: #991b1b;">
                        <li>Nếu không thấy WiFi "ESP32_SmartHome", hãy reset ESP32 bằng nút RESET trên board</li>
                        <li>Đảm bảo WiFi nhà bạn hoạt động ở tần số 2.4GHz (ESP32 không hỗ trợ 5GHz)</li>
                        <li>IP <code>${espIP}</code> chỉ hoạt động khi bạn kết nối vào WiFi của ESP32</li>
                    </ul>
                </div>
            </div>
        `;
        
        guideDiv.style.display = 'block';
    } else {
        guideDiv.style.display = 'none';
    }
};

