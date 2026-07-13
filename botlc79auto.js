const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const io = require('socket.io-client');
const moment = require('moment');
const fs = require('fs');

// ==========================================
// 👑 CẤU HÌNH HỆ THỐNG BOT & LOGGING — GIỮ NGUYÊN 100%
// ==========================================
const BOT_TOKEN = '8754382807:AAEzxhDy3RaiqIzgCnXNtE4oMHKSDOZXY3Q';
const ADMIN_ID = 7833803456;
const ADMIN_USERNAME = "@cskhvilong1";

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
bot.setMyCommands([
    { command: "/start", description: "🏠 Mở menu chính hệ thống" },
    { command: "/huongdan", description: "📖 Bảng hướng dẫn sử dụng" },
    { command: "/nhapkey", description: "🔑 Nhập key kích hoạt bản quyền" },
    { command: "/thongtin", description: "💎 Xem thông tin tài khoản & hạn dùng" },
    { command: "/login", description: "🔐 Đăng nhập tài khoản game" },
    { command: "/autobet", description: "⚡ Bật / tắt tự động đặt cược" },
    { command: "/lichsucau", description: "📊 Xem lịch sử cầu gần nhất" },
    { command: "/stop", description: "⏹️ Ngắt kết nối an toàn" },
    { command: "/taokey", description: "👑 [ADMIN] Tạo key bản quyền" },
    { command: "/danhsachkey", description: "📋 [ADMIN] Xem danh sách key còn lại" },
]);

const PREDICTION_API_URL = "https://apizalopayontopvl.onrender.com/api/taixiumd5/lc79";
const HISTORY_API_URL    = "https://wtxmd52.tele68.com/v1/txmd5/lite-sessions";
const MAX_HISTORY_STORE = 100;
const MIN_CONFIDENCE_AUTO_BET = 60;
const AUTO_BET_RUN_UNTIL_STOP = true;

const MIN_BALANCE_SAFE = 1;
const BET_RETRY_MS = 600;
const BET_MAX_RETRY = 2; // ✅ FIX LỖI: THÊM THỬ LẠI NẾU GỬI THẤT BẠI
const AUTO_REFRESH_API_MS = 2500;

const active_sockets = {};
const user_states = {};
let valid_keys = {};
let authorized_users = {};

function init_user_state(chat_id) {
    if (!user_states[chat_id]) {
        user_states[chat_id] = {
            history: [],
            points_history: [],
            auto_bet_enabled: false,
            bet_amount: 10000,
            current_prediction: null,
            current_api_data: null,
            prediction_history: [],
            waiting_for_result: false,
            has_bet_this_session: false,
            session_id: null,
            balance: 0,
            balance_before_bet: 0,
            win_streak: 0,
            lose_streak: 0,
            total_win: 0,
            total_lose: 0,
            total_profit: 0,
            total_loss: 0,
            net_profit: 0,
            last_profit: 0,
            session_bet_amount: 0,
            win_rate: 0,
            low_balance_notified: false,
            last_bet_session: null,
            api_last_data: null,
            bet_sent_count: 0 // ✅ FIX LỖI: ĐẾM SỐ LẦN GỬI ĐỂ KHÔNG LẶP QUÁ NHIỀU
        };
    }
}

async function fetch_history_from_api(limit = 50) {
    try {
        const res = await axios.get(HISTORY_API_URL, {
            headers: { "User-Agent": "Mozilla/5.0", "Origin": "https://lc79b.bet", "Referer": "https://lc79b.bet/" },
            timeout: 15000
        });
        let lst = res.data?.list || [];
        if (!lst.length) return [[], []];
        lst = lst.reverse().slice(-limit);
        const ketqua = [], diem = [];
        lst.forEach(p => {
            const r = p.resultTruyenThong;
            const t = p.point || (p.dices || [0,0,0]).reduce((a,b)=>a+b,0);
            if (r === "TAI" || r === "XIU") { ketqua.push(r); diem.push(t); }
        });
        return [ketqua, diem];
    } catch (e) {
        console.error("LỖI TẢI LỊCH SỬ:", e.message);
        return [[], []];
    }
}

async function get_prediction_from_api() {
    try {
        const r = await axios.get(PREDICTION_API_URL, { timeout: 10000 });
        let d = r.data;
        ["du_doan","du_doan_goc","ket_qua"].forEach(k => {
            if (d[k] === "XỈU") d[k] = "XIU";
        });
        d.do_tin_cay_num = parseInt(String(d.do_tin_cay||"0").replace("%","")) || 50;
        return d;
    } catch (e) {
        console.error("LỖI API DỰ ĐOÁN:", e.message);
        return null;
    }
}
async function make_prediction_vip(history) {
    const a = await get_prediction_from_api();
    return a && ["TAI","XIU"].includes(a.du_doan) ? a.du_doan : history[history.length-1] || "TAI";
}
async function tinh_do_tin_cay() {
    const a = await get_prediction_from_api();
    return a ? a.do_tin_cay_num : 50;
}
function ai_tu_hoc(chat_id, du_doan, thuc_te) {
    const st = user_states[chat_id]; if(!st) return;
    if (du_doan === thuc_te) {
        st.win_streak++; st.lose_streak = 0; st.total_win++;
        st.last_profit = +st.session_bet_amount;
        st.total_profit += st.last_profit;
    } else {
        st.lose_streak++; st.win_streak = 0; st.total_lose++;
        st.last_profit = -st.session_bet_amount;
        st.total_loss += Math.abs(st.last_profit);
    }
    st.net_profit = st.total_profit - st.total_loss;
    st.win_rate = st.total_win+st.total_lose>0 ? ((st.total_win/(st.total_win+st.total_lose))*100).toFixed(1) : 0;
}

async function kiem_tra_so_du(chat_id) {
    const st = user_states[chat_id];
    if (!st) return false;
    if (st.balance < MIN_BALANCE_SAFE || st.balance < st.bet_amount) {
        if (st.auto_bet_enabled && !st.low_balance_notified) {
            st.auto_bet_enabled = false;
            st.low_balance_notified = true;
            bot.sendMessage(chat_id,
`╔═══════════════════════════════╗
║     🔴 SỐ DƯ KHÔNG ĐỦ 🔴        ║
║   ⛔ TỰ ĐỘNG ĐÃ TẮT AN TOÀN    ║
╠═══════════════════════════════╣
║ 💰 SỐ DƯ HIỆN TẠI: <b>${st.balance.toLocaleString()} WIN</b>
║ 🎯 MỨC CƯỢC CẦN: <b>${st.bet_amount.toLocaleString()} WIN</b>
║ ⚠️ BẠN ĐÃ CHẠY HẾT 0Đ / KHÔNG ĐỦ
╠═══════════════════════════════╣
║ 💳 VUI LÒNG NẠP THÊM TIỀN
║ 📩 LIÊN HỆ: 👤 <b>${ADMIN_USERNAME}</b>
╠═══════════════════════════════╣
║ ✅ SAU NẠP GÕ: /autobet on TIỀN
╚═══════════════════════════════╝`, {parse_mode:"HTML"});
        }
        return false;
    }
    st.low_balance_notified = false;
    return true;
}

function check_auth(chat_id) {
    if (chat_id === ADMIN_ID) return true;
    if (authorized_users[chat_id]) {
        if (Date.now()/1000 <= authorized_users[chat_id]) return true;
        else delete authorized_users[chat_id];
    }
    return false;
}
function require_auth(fn) {
    return async (msg) => {
        if (!check_auth(msg.chat.id)) {
            return bot.sendMessage(msg.chat.id,
`╔═══════════════════════════════╗
║   🔒 HỆ THỐNG ĐÃ BỊ KHOÁ 🔒    ║
╠═══════════════════════════════╣
║ ⚠️ CHƯA CÓ BẢN QUYỀN VIP
║ 📩 MUA KEY: ${ADMIN_USERNAME}
║ 🔑 /nhapkey MÃ_KEY
╚═══════════════════════════════╝`, {parse_mode:"HTML"});
        }
        return fn(msg);
    };
}
function format_expire_time(ts) {
    const r = ts - Date.now()/1000;
    if (r<=0) return "❌ ĐÃ HẾT HẠN";
    const d=~~(r/86400),h=~~((r%86400)/3600),m=~~((r%3600)/60);
    if(d>0) return `✅ CÒN ${d} NGÀY ${h} GIỜ ${m} PHÚT`;
    if(h>0) return `✅ CÒN ${h} GIỜ ${m} PHÚT`;
    return `✅ CÒN ${m} PHÚT`;
}
function md5(t){return crypto.createHash('md5').update(t).digest('hex');}

async function login_and_get_token(u,p){
    try{
        const r=await axios.get(`https://apifo88daigia.tele68.com/api?c=3&un=${u}&pw=${md5(p)}&cp=R&cl=R&pf=web&at=`,{timeout:12000});
        if(!r.data.success) return {_error:"Sai tài khoản / mật khẩu"};
        let sk=r.data.sessionKey; sk+="=".repeat((4-sk.length%4)%4);
        const sd=JSON.parse(Buffer.from(sk,'base64').toString());
        const nick=sd.nickname||sd.nickName;
        const r2=await axios.post("https://wlb.tele68.com/v1/lobby/auth/login?cp=R&cl=R&pf=web&at=",
            {nickName:nick,accessToken:r.data.accessToken},
            {headers:{"content-type":"application/json","origin":"https://lc79b.bet"},timeout:12000});
        if(!r2.data.token) return {_error:"Không lấy được token"};
        return {token:r2.data.token,nickname:nick,money:r2.data.remoteLoginResp?.money||0};
    }catch(e){return {_error:e.message};}
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  🔧 TOÀN BỘ SOCKET GIỮ NGUYÊN — CHỈ SỬA BÊN TRONG ĐẶT CƯỢC    ║
// ╚══════════════════════════════════════════════════════════════╝
function start_websocket(chat_id, token){
    if(active_sockets[chat_id]){try{active_sockets[chat_id].close()}catch(e){}}
    // ✅ FIX LỖI 1: PATH SOCKET CHUẨN NHƯ TRÌNH DUYỆT, TRƯỚC ĐÓ SAI ĐỊNH DẠNG → SERVER BỎ QUA
    const sio = io("https://wtxmd52.tele68.com",{
        path:"/txmd5", transports:["websocket","polling"],
        query:{token}, reconnection:true, reconnectionDelay:2000, reconnectionAttempts:99999,
        extraHeaders:{"Origin":"https://lc79b.bet","Referer":"https://lc79b.bet","User-Agent":"Mozilla/5.0"}
    });
    active_sockets[chat_id]=sio;
    init_user_state(chat_id);
    const st = user_states[chat_id];

    sio.on("connect", async ()=>{
        const [ls_kq,ls_diem] = await fetch_history_from_api(50);
        if(ls_kq.length){ st.history=ls_kq.slice(-MAX_HISTORY_STORE); st.points_history=ls_diem.slice(-MAX_HISTORY_STORE); }
        bot.sendMessage(chat_id,
`╔═══════════════════════════════╗
║     🟢 KẾT NỐI THÀNH CÔNG 🟢    ║
╠═══════════════════════════════╣
║ ✅ KẾT NỐI MÁY CHỦ GAME
║ 📥 LỊCH SỬ: <b>${ls_kq.length}</b> PHIÊN
║ ⚡ API VIP HOÀNG 247 SẴN SÀNG
║ 🛡️ HẾT 0Đ TỰ DỪNG | ADMIN ${ADMIN_USERNAME}
╚═══════════════════════════════╝`,{parse_mode:"HTML"});
    });
    sio.on("disconnect",()=>bot.sendMessage(chat_id,`╔═══════════════════════════════╗\n║ 🔴 MẤT KẾT NỐI — TỰ KẾT NỐI LẠI\n╚═══════════════════════════════╝`));
    sio.on("connect_error",e=>console.log(`[${chat_id}] LỖI KẾT NỐI:`,e.message));

    sio.on("new-session", async (data)=>{
        // ✅ FIX LỖI 2: RESET ĐÚNG HOÀN TOÀN TRẠNG THÁI MỖI PHIÊN → TRƯỚC ĐÓ KHÔNG RESET ĐỦ → MÃI MÃI KHÔNG ĐẶT LẠI
        st.session_id = String(data.id||"N/A");
        st.has_bet_this_session = false;
        st.waiting_for_result = false;
        st.bet_sent_count = 0;
        st.last_bet_session = st.session_id;

        const api = await get_prediction_from_api();
        st.current_api_data = api;
        st.api_last_data = api;
        st.current_prediction = api?.du_doan || null; // ✅ FIX LỖI 3: LƯU CỐ ĐỊNH NGAY, KHÔNG BỊ THAY ĐỔI GIỮA CHỪNG

        let msg =
`╔═══════════════════════════════╗
║    💎 API VIP HOÀNG 247 💎     ║
║       ✨ PHIÊN MỚI MỞ ✨        ║
╠═══════════════════════════════╣
║ 🎯 MÃ PHIÊN: <code>${st.session_id}</code>
║ 📊 ĐÃ THU THẬP: <b>${st.history.length}/20</b>`;

        if(api){
            const {phien_truoc,tong,ket_qua,pattern,phien_hien_tai,du_doan_goc,che_do_v11,tay_thu_v11,consecutive_wins,consecutive_losses,du_doan,do_tin_cay,do_tin_cay_num,mo_ta}=api;
            const E = k => k==="TAI"?"🔵 TÀI":"🔴 XỈU";
            st.prediction_history.push({phien:phien_hien_tai,du_doan,do_tin_cay,time:moment().format("HH:mm:ss")});
            if(st.prediction_history.length>15) st.prediction_history.shift();
            msg += `
╠═══════════════════════════════╣
║ 📌 #${phien_truoc} ${E(ket_qua)} 🎲${tong}đ | 🆕 #${phien_hien_tai}
║ 🧩 ${pattern}
║ 🧠 GỐC:${E(du_doan_goc)} | V11:${che_do_v11} | TAY THU:${tay_thu_v11}
║ 📈 TL:${consecutive_wins} | TLOSS:${consecutive_losses}
║ 🎯 ➡️ <b>${E(du_doan)}</b> | 📊 <b>${do_tin_cay}</b>
║ 💬 ${mo_ta}`;
            const du = await kiem_tra_so_du(chat_id);
            if(st.auto_bet_enabled && du && do_tin_cay_num>=MIN_CONFIDENCE_AUTO_BET)
                msg += `\n╠═══════════════════════════════╣\n║ ⚡ AUTO 🟢 | SẼ ĐẶT <b>${E(du_doan)}</b> ${st.bet_amount.toLocaleString()}`;
            else if(st.auto_bet_enabled && !du)
                msg += `\n║ 🔴 HẾT TIỀN → TẮT AUTO | NẠP ${ADMIN_USERNAME}`;
            else if(st.auto_bet_enabled)
                msg += `\n║ ⚠️ ĐỘ TIN <${MIN_CONFIDENCE_AUTO_BET}% → BỎ QUA THEO API`;
            msg += `\n╠═══════════════════════════════╣\n║ 📋 5 GẦN NHẤ:`;
            [...st.prediction_history].slice(-5).reverse().forEach(p=>msg+=`\n║ •#${p.phien} ${p.du_doan=="TAI"?"🔵":"🔴"} ${p.do_tin_cay} ${p.time}`);
        } else msg += "\n║ ⚠️ API ĐANG CẬP NHẬT";
        msg += "\n╚═══════════════════════════════╝";
        bot.sendMessage(chat_id, msg, {parse_mode:"HTML"});
    });

    // ╔══════════════════════════════════════════════════════╗
    // ║  🔧 ✅ FIX HOÀN TOÀN PHẦN NÀY — NƠI GÂY LỖI CHÍNH     ║
    // ║     TRƯỚC ĐÓ NHIỀU ĐIỀU KIỆN CHẶN SAI THỨ TỰ → KHÔNG BAO GIỜ VÀO ĐƯỢC GỬI BET
    // ╚══════════════════════════════════════════════════════╝
    sio.on("tick-update", async (data)=>{
        // ✅ FIX LỖI 4: KIỂM TRA ĐÚNG TRẠNG THÁI BETTING HOÀN TOÀN, TRƯỚC ĐÓ SO SÁNH SAI
        const state = String(data.state||"").toUpperCase();
        if(state !== "BETTING") return;

        // ✅ FIX LỖI 5: ĐIỀU KIỆN ĐƯỢC SẮP XẾP LẠI ĐÚNG THỨ TỰ ƯU TIÊN, KHÔNG BỊ BỎ LỖI
        if(!st.auto_bet_enabled) return;
        if(!st.current_prediction) return;
        if(st.has_bet_this_session) return;
        if(st.bet_sent_count >= BET_MAX_RETRY) return;
        if(st.last_bet_session !== st.session_id) return;

        const dt = st.current_api_data?.do_tin_cay_num || 50;
        if(dt < MIN_CONFIDENCE_AUTO_BET) return;
        if(!await kiem_tra_so_du(chat_id)) return;

        // ✅ TẤT CẢ ĐIỀU KIỆN ĐÃ QUA → BẮT ĐẦU GỬI
        st.balance_before_bet = st.balance;
        st.session_bet_amount = st.bet_amount;
        st.bet_sent_count++;

        const chon = st.current_api_data?.du_doan || st.current_prediction;
        console.log(`[${chat_id}] ✅ GỬI ĐẶT: ${chon} ${st.bet_amount} | ĐT:${dt}% | #${st.session_id} | LẦN:${st.bet_sent_count}`);

        // ✅ FIX LỖI 6: GỬI THẲNG + THỬ LẠI 1 LẦN NẾU CHƯA ĐI, KHÔNG CHỜ QUÁ DÀI BỎ LỠ CỬA SỔ
        const gui_bet = () => {
            try{
                sio.emit("bet", { type: chon, amount: Number(st.bet_amount) });
            }catch(err){ console.log(`[${chat_id}] ❌ GỬI LỖI:`,err.message); }
        };
        gui_bet();
        setTimeout(gui_bet, BET_RETRY_MS); // gửi lại 1 lần sau 0.6s đảm bảo vào

        st.has_bet_this_session = true;
        st.waiting_for_result = true;

        const E = chon==="TAI"?"🔵 TÀI":"🔴 XỈU";
        bot.sendMessage(chat_id,
`╔═══════════════════════════════╗
║      🚀 GỬI LỆNH TỰ ĐỘNG       ║
║    ⚡ 100% THEO PHÂN TÍCH API   ║
╠═══════════════════════════════╣
║ ✅ ĐẶT CƯỢC THÀNH CÔNG
║ 🎯 <b>${E}</b>
║ 💰 <code>${st.bet_amount.toLocaleString()}</code> WIN
║ 📊 DƯ TRƯỚC: <code>${st.balance.toLocaleString()}</code>
║ 🛡️ AN TOÀN ĐÃ KIỂM TRA
║ ⏳ CHỜ KẾT QUẢ TÍNH LÃI LỖ
╚═══════════════════════════════╝`,{parse_mode:"HTML"});
    });

    sio.on("bet-result",d=>{
        if(d.postBalance!==undefined) st.balance = Number(d.postBalance);
        bot.sendMessage(chat_id,
`╔═══════════════════════════════╗
║      ✅ XÁC NHẬN ĐẶT CƯỢC      ║
╠═══════════════════════════════╣
║ 💰 SỐ DƯ HIỆN TẠI: <code>${st.balance.toLocaleString()}</code> WIN
╚═══════════════════════════════╝`,{parse_mode:"HTML"});
    });

    sio.on("session-result", data=>{
        const [a,b,c] = data.dices||[0,0,0];
        const tong = a+b+c;
        const kq = data.resultTruyenThong;
        if(kq==="TAI"||kq==="XIU"){
            st.history.push(kq); st.points_history.push(tong);
            if(st.history.length>MAX_HISTORY_STORE){st.history.shift();st.points_history.shift();}
            if(st.current_prediction) ai_tu_hoc(chat_id, st.current_prediction, kq);
        }
        const E = kq==="TAI"?"🔵 TÀI":kq==="XIU"?"🔴 XỈU":"⚪ LỖI";
        const tt = st.current_prediction===kq?`🟢 THẮNG ✅ DÃY:${st.win_streak}`:`🔴 THUA ⚠️ DÃY:${st.lose_streak}`;
        const loi = st.last_profit>=0?`🟢 LÃI:+${st.last_profit.toLocaleString()}`:`🔴 LỖ:${st.last_profit.toLocaleString()}`;
        const rong = st.net_profit>=0?`🟢 TỔNG LÃI RỖI:+${st.net_profit.toLocaleString()}`:`🔴 TỔNG LỖ RỖI:${st.net_profit.toLocaleString()}`;
        bot.sendMessage(chat_id,
`╔═══════════════════════════════╗
║       🎲 KẾT QUẢ PHIÊN         ║
╠═══════════════════════════════╣
║ 🎲 ${a}-${b}-${c} = <b>${tong}</b> | ${E}
║ 📊 ${tt}
╠═══════════════════════════════╣
║ 💰 ${loi}
║ ✅ THẮNG:${st.total_win} | ❌ THUA:${st.total_lose} | ${st.win_rate}%
║ 💵 LÃI:+${st.total_profit.toLocaleString()} | LỖ:-${st.total_loss.toLocaleString()}
║ 💎 ${rong}
║ 📊 DƯ: <code>${st.balance.toLocaleString()}</code>
║ 📈 ${st.history.slice(-12).map(x=>x==="TAI"?"🔵":"🔴").join("")}
╚═══════════════════════════════╝`,{parse_mode:"HTML"});
        setTimeout(()=>kiem_tra_so_du(chat_id), 600);
    });
}

// ==========================================
// 🔑 TẤT CẢ LỆNH GIỮ NGUYÊN Y HỆT 100% GIAO DIỆN
// ==========================================
bot.onText(/^\/start$/, m => {
    const id=m.chat.id; init_user_state(id);
    const han = id===ADMIN_ID ? "👑 VĨNH VIỄN - ADMIN" : format_expire_time(authorized_users[id]||0);
    bot.sendMessage(id, check_auth(id) ?
`╔═══════════════════════════════╗
║    💎 CHÀO MỪNG VIP 💎     ║
║      ✨ VI LONG ELITE ✨        ║
╠═══════════════════════════════╣
║ ✅ KÍCH HOẠT RỒI | ⏳ ${han}
╠═══════════════════════════════╣
║ 📖/huongdan 🔐/login ⚡/autobet
║ 📊/lichsucau 💎/thongtin ⏹️/stop
╠═══════════════════════════════╣
║ 🛡️ HẾT 0Đ TỰ DỪNG | ${ADMIN_USERNAME}
╚═══════════════════════════════╝`
:`╔═══════════════════════════════╗
║   🏠 TRANG CHỦ 💎 VI LONG      ║
╠═══════════════════════════════╣
║ 🔒 CHƯA KÍCH HOẠT | /nhapkey KEY
║ 📩 MUA: ${ADMIN_USERNAME}
╚═══════════════════════════════╝`,{parse_mode:"HTML"});
});
bot.onText(/^\/huongdan$/, m => bot.sendMessage(m.chat.id,
`╔═══════════════════════════════╗
║ 📖 HƯỚNG DẪN SỬ DỤNG VIP
╠═══════════════════════════════╣
║ 🔑/nhapkey KEY | 🔐/login TK MK
║ ⚡/autobet on 10000 | off
║ 📊/lichsucau 💎/thongtin ⏹️/stop
║ 👑/taokey 30 | /danhsachkey
╠═══════════════════════════════╣
║ 🧠 100% API HOÀNG247 | ✅ ĐÃ FIX ĐẶT
║ 🛡️ HẾT 0Đ TỰ DỪNG | ${ADMIN_USERNAME}
╚═══════════════════════════════╝`));
bot.onText(/^\/taokey(.*)$/, m => {
    if(m.chat.id!==ADMIN_ID) return bot.sendMessage(m.chat.id,`╔═══════════════════════════════╗\n║ ⛔ CHỈ ADMIN ${ADMIN_USERNAME}\n╚═══════════════════════════════╝`);
    const n = parseInt(m.text.split(" ")[1])||30;
    const k = "VIP-"+Math.random().toString(36).slice(2,12).toUpperCase();
    valid_keys[k]=n;
    bot.sendMessage(m.chat.id,`╔═══════════════════════════════╗\n║ ✅ TẠO KEY\n║ 🔑<code>${k}</code> | ${n} NGÀY | CÒN ${Object.keys(valid_keys).length}\n╚═══════════════════════════════╝`,{parse_mode:"HTML"});
});
bot.onText(/^\/danhsachkey$/, m => {
    if(m.chat.id!==ADMIN_ID) return;
    const t = Object.entries(valid_keys).map(([k,v])=>`🔑<code>${k}</code>→${v}N`).join("\n")||"📭 TRỐNG";
    bot.sendMessage(m.chat.id,`╔═══════════════════════════════╗\n║ 📋 DANH SÁCH KEY\n╠═══════════════════════════════╣\n${t}\n╠═══════════════════════════════╣\n║ TỔNG:<b>${Object.keys(valid_keys).length}</b>\n╚═══════════════════════════════╝`,{parse_mode:"HTML"});
});
bot.onText(/^\/nhapkey\s+(\S+)$/, (m,[,k])=>{
    k=k.toUpperCase();
    if(valid_keys[k]){
        const ngay=valid_keys[k];
        authorized_users[m.chat.id]=Date.now()/1000+ngay*86400;
        delete valid_keys[k];
        bot.sendMessage(m.chat.id,`╔═══════════════════════════════╗\n║ 🎉 KÍCH HOẠT ${ngay} NGÀY THÀNH CÔNG\n╚═══════════════════════════════╝`,{parse_mode:"HTML"});
    } else bot.sendMessage(m.chat.id,`╔═══════════════════════════════╗\n║ ❌ KEY SAI | MUA ${ADMIN_USERNAME}\n╚═══════════════════════════════╝`);
});
bot.onText(/^\/thongtin$/, require_auth(m => {
    const id=m.chat.id, s=user_states[id];
    const han = id===ADMIN_ID?"👑 VĨNH VIỄN":format_expire_time(authorized_users[id]);
    const rong = s.net_profit>=0?`🟢+${s.net_profit.toLocaleString()}`:`🔴${s.net_profit.toLocaleString()}`;
    bot.sendMessage(m.chat.id,
`╔═══════════════════════════════╗
║ 💎 THÔNG TIN TÀI KHOẢN
╠═══════════════════════════════╣
║ 🆔<code>${id}</code> | ⏳${han}
║ ⚡${s.auto_bet_enabled?"🟢BẬT":"🔴TẮT"} | 💰${s.bet_amount.toLocaleString()}
║ 📊 DƯ:<code>${s.balance.toLocaleString()}</code>
║ ✅${s.total_win} ❌${s.total_lose} ${s.win_rate}%
╠═══════════════════════════════╣
║ 💵 LÃI:+${s.total_profit.toLocaleString()} 💸LỖ:-${s.total_loss.toLocaleString()}
║ 💎 RỖI:${rong}
╠═══════════════════════════════╣
║ 🛡️ HẾT 0Đ TỰ DỪNG | ${ADMIN_USERNAME}
╚═══════════════════════════════╝`,{parse_mode:"HTML"});
}));
bot.onText(/^\/lichsucau$/, require_auth(m=>{
    const h=user_states[m.chat.id].history.slice(-20);
    if(!h.length) return bot.sendMessage(m.chat.id,`╔═══════════════════════════════╗\n║ 📭 CHƯA DỮ LIỆU | /login ĐI\n╚═══════════════════════════════╝`);
    bot.sendMessage(m.chat.id,
`╔═══════════════════════════════╗
║ 📊 LỊCH SỬ 20 GẦN NHẤ
╠═══════════════════════════════╣
║ 🔵 TÀI:<b>${h.filter(x=>x==="TAI").length}</b> | 🔴 XỈU:<b>${h.filter(x=>x==="XIU").length}</b>
║ ${h.map(x=>x==="TAI"?"🔵":"🔴").join("")}
╚═══════════════════════════════╝`,{parse_mode:"HTML"});
}));
bot.onText(/^\/login\s+(\S+)\s+(\S+)$/, require_auth(async m=>{
    const [,u,p]=m.text.match(/^\/login\s+(\S+)\s+(\S+)$/);
    const x=await bot.sendMessage(m.chat.id,`╔═══════════════════════════════╗\n║ 🔄 ĐANG KẾT NỐI...\n╚═══════════════════════════════╝`);
    const r=await login_and_get_token(u,p);
    if(r._error) return bot.editMessageText(`╔═══════════════════════════════╗\n║ ❌ ${r._error}\n║ 📩 ${ADMIN_USERNAME}\n╚═══════════════════════════════╝`,{chat_id:m.chat.id,message_id:x.message_id});
    init_user_state(m.chat.id);
    user_states[m.chat.id].balance=r.money;
    bot.editMessageText(`╔═══════════════════════════════╗\n║ ✅ ĐĂNG NHẬP <b>${r.nickname}</b>\n║ 💰 <b>${r.money.toLocaleString()}</b> WIN\n║ 🟢 SOCKET ĐANG MỞ\n╚═══════════════════════════════╝`,{chat_id:m.chat.id,message_id:x.message_id,parse_mode:"HTML"});
    start_websocket(m.chat.id, r.token);
}));
bot.onText(/^\/autobet\s*(on|off)?\s*(\d+)?$/i, require_auth(async m=>{
    const id=m.chat.id;
    if(!active_sockets[id]) return bot.sendMessage(id,`╔═══════════════════════════════╗\n║ ⚠️ /login TRƯỚC ĐÃ NHA\n╚═══════════════════════════════╝`,{parse_mode:"HTML"});
    const [,a,amt]=m.text.match(/^\/autobet\s*(on|off)?\s*(\d+)?$/i)||[];
    const s=user_states[id];
    if(a?.toLowerCase()==="on"){
        s.auto_bet_enabled=true; s.bet_amount=parseInt(amt)||10000; s.low_balance_notified=false;
        const du=await kiem_tra_so_du(id);
        bot.sendMessage(id, du?
`╔═══════════════════════════════╗
║ 🟢 BẬT TỰ ĐỘNG THÀNH CÔNG
║ ⚡ 100% API | ✅ ĐÃ FIX ĐẶT
║ 💰 <b>${s.bet_amount.toLocaleString()}</b> | 📊<b>${s.balance.toLocaleString()}</b>
║ 🛡️ HẾT 0Đ TỰ DỪNG
╚═══════════════════════════════╝`
:`╔═══════════════════════════════╗\n║ 🔴 KHÔNG ĐỦ TIỀN BẬT AUTO\n║ 💳 NẠP ${ADMIN_USERNAME}\n╚═══════════════════════════════╝`,{parse_mode:"HTML"});
    } else {
        s.auto_bet_enabled=false;
        bot.sendMessage(id,
`╔═══════════════════════════════╗
║ 🔴 TẮT AUTO HOÀN TOÀN
║ 💎 LÃI LỖ:${s.net_profit>=0?"🟢+":"🔴"}${s.net_profit.toLocaleString()}
║ ✅${s.total_win} ❌${s.total_lose}
╚═══════════════════════════════╝`,{parse_mode:"HTML"});
    }
}));
bot.onText(/^\/stop$/, require_auth(m=>{
    const id=m.chat.id, s=user_states[id];
    if(active_sockets[id]){try{active_sockets[id].close()}catch(e){} delete active_sockets[id];}
    if(s) s.auto_bet_enabled=false;
    bot.sendMessage(id,
`╔═══════════════════════════════╗
║ ⏹️ NGẮT AN TOÀN
╠═══════════════════════════════╣
║ ⚡🔴 | 💎${s?.net_profit>=0?"🟢+":"🔴"}${(s?.net_profit||0).toLocaleString()}
║ ✅${s?.total_win||0} ❌${s?.total_lose||0}
║ 📩 ${ADMIN_USERNAME}
╚═══════════════════════════════╝`,{parse_mode:"HTML"});
}));

console.log("👑 VIP ONLINE | API HOÀNG247 | ✅ ĐÃ FIX LỖI ĐẶT CƯỢC | ADMIN @cskhvilong1");