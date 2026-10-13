"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// JUKKINGDOM Web (Vercel)
const client_1 = require("@prisma/client");
const express_1 = __importStar(require("express"));
const node_crypto_1 = require("crypto");
const pino_1 = __importDefault(require("pino"));
const zod_1 = require("zod");
// ===== config.ts =====
const envSchema = zod_1.z.object({
    DISCORD_CLIENT_ID: zod_1.z.string().min(5),
    DISCORD_CLIENT_SECRET: zod_1.z.string().min(10),
    DISCORD_GUILD_ID: zod_1.z.string().optional().transform((v) => v || "jukkingdom"),
    OWNER_DISCORD_ID: zod_1.z.string().regex(/^\d{15,25}$/),
    DATABASE_URL: zod_1.z.string().min(10),
    SESSION_SECRET: zod_1.z.string().min(32),
    BASE_URL: zod_1.z.string().url().transform((v) => v.replace(/\/+$/, "")),
    DISCORD_INVITE_URL: zod_1.z.string().optional().transform((v) => (v && /^https:\/\//.test(v) ? v : undefined)),
    NODE_ENV: zod_1.z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: zod_1.z.string().default("info"),
});
// ถ้าไม่ได้ตั้ง BASE_URL ใช้โดเมน Production ของ Vercel ให้อัตโนมัติ
const env = { ...process.env, BASE_URL: process.env.BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL : "") };
const parsed = envSchema.safeParse(env);
if (!parsed.success) {
    // แสดงเฉพาะชื่อตัวแปรที่ผิด ไม่แสดงค่า
    console.error("ตั้งค่า Environment ไม่ถูกต้อง ตรวจตัวแปรเหล่านี้:", Object.keys(parsed.error.flatten().fieldErrors).join(", "));
    process.exit(1);
}
const config = parsed.data;
const BRAND_COLOR = 0x8b0000;
// ===== logger.ts =====
const logger = (0, pino_1.default)({
    level: config.LOG_LEVEL,
    redact: ["token", "*.token", "password", "*.password", "DISCORD_TOKEN", "DISCORD_CLIENT_SECRET", "SESSION_SECRET", "DATABASE_URL"],
});
// ===== db.ts =====
const prisma = new client_1.PrismaClient();
// ===== lib/money.ts =====
/** บาท (ทศนิยม ≤2 ตำแหน่ง) -> สตางค์ (Int) ไม่ใช้ Float คำนวณเงิน */
function bahtToSatang(input) {
    const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/,/g, ""));
    if (!m)
        return null;
    return parseInt(m[1], 10) * 100 + parseInt((m[2] ?? "").padEnd(2, "0") || "0", 10);
}
function formatBaht(satang) {
    const baht = Math.trunc(satang / 100);
    const s = satang % 100;
    return `฿${baht.toLocaleString("en-US")}${s ? "." + String(s).padStart(2, "0") : ""}`;
}
function satangToInput(satang) {
    return (satang / 100).toFixed(2).replace(/\.00$/, "");
}
// ===== lib/format.ts =====
const ORDER_STATUS_TH = {
    PENDING: "รอตรวจสอบ", CONFIRMED: "ยืนยันออเดอร์แล้ว", IN_PROGRESS: "กำลังดำเนินงาน",
    WAITING_CUSTOMER: "รอข้อมูลจากลูกค้า", REVISION: "กำลังแก้ไขงาน", COMPLETED: "เสร็จสิ้น", CANCELLED: "ยกเลิก",
};
const PAYMENT_STATUS_TH = {
    UNPAID: "ยังไม่ชำระ", PENDING_VERIFICATION: "รอตรวจสอบหลักฐาน", PARTIALLY_PAID: "ชำระบางส่วน",
    PAID: "ชำระแล้ว", REJECTED: "ปฏิเสธหลักฐาน", REFUNDED: "คืนเงินแล้ว",
};
/** สถานะที่เปลี่ยนต่อได้ */
const TRANSITIONS = {
    PENDING: ["CONFIRMED", "CANCELLED"],
    CONFIRMED: ["IN_PROGRESS", "WAITING_CUSTOMER", "CANCELLED"],
    IN_PROGRESS: ["WAITING_CUSTOMER", "REVISION", "COMPLETED", "CANCELLED"],
    WAITING_CUSTOMER: ["IN_PROGRESS", "CANCELLED"],
    REVISION: ["IN_PROGRESS", "COMPLETED", "CANCELLED"],
    COMPLETED: ["REVISION"],
    CANCELLED: [],
};
const thDate = (d) => d ? d.toLocaleString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" }) : "-";
const thDay = (d) => d ? d.toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium" }) : "-";
// ===== lib/embeds.ts =====
/** Embed แบบเบา ๆ สำหรับส่งผ่าน Discord Webhook (ไม่ต้องใช้ discord.js) */
class Embed {
    d = {};
    setTitle(t) { this.d.title = t.slice(0, 256); return this; }
    setDescription(t) { this.d.description = t.slice(0, 4000); return this; }
    setColor(c) { this.d.color = c; return this; }
    addFields(...f) {
        const cur = this.d.fields ?? [];
        this.d.fields = [...cur, ...f.map((x) => ({ name: x.name.slice(0, 256), value: (x.value || "-").slice(0, 1024), inline: !!x.inline }))].slice(0, 25);
        return this;
    }
    setFooter(o) { this.d.footer = o; return this; }
    setTimestamp() { this.d.timestamp = new Date().toISOString(); return this; }
    toJSON() { return this.d; }
}
const brandEmbed = (color = BRAND_COLOR) => new Embed().setColor(color).setFooter({ text: "JUKKINGDOM" }).setTimestamp();
// ===== services/guild.ts =====
let guildCache = null; // แคชต่อ instance ลดการ query ซ้ำ
async function getGuild() {
    if (guildCache)
        return guildCache;
    guildCache = await prisma.guild.upsert({ where: { discordId: config.DISCORD_GUILD_ID }, update: {}, create: { discordId: config.DISCORD_GUILD_ID } });
    return guildCache;
}
async function getSettings() {
    const guild = await getGuild();
    const settings = await prisma.guildSettings.upsert({ where: { guildId: guild.id }, update: {}, create: { guildId: guild.id } });
    return { guild, settings };
}
async function audit(db, guildId, actorDiscordId, action, entity, entityId, before, after) {
    await db.auditLog.create({
        data: {
            guildId, actorDiscordId, action, entity, entityId,
            before: (before ?? undefined),
            after: (after ?? undefined),
        },
    });
}
const rank = { CUSTOMER: 0, STAFF: 1, ADMIN: 2, OWNER: 3 };
const atLeast = (l, min) => rank[l] >= rank[min];
/** หา StaffMember จาก Discord ID (ตรวจจากฐานข้อมูลทุกครั้ง) เจ้าของร้านใน env จะถูกสร้างเป็น OWNER อัตโนมัติ */
async function resolveStaff(discordId) {
    const guild = await getGuild();
    if (discordId === config.OWNER_DISCORD_ID) {
        return prisma.staffMember.upsert({
            where: { guildId_discordId: { guildId: guild.id, discordId } },
            update: { role: "OWNER", deletedAt: null },
            create: { guildId: guild.id, discordId, role: "OWNER" },
        });
    }
    return prisma.staffMember.findFirst({ where: { guildId: guild.id, discordId, deletedAt: null } });
}
// ===== notify.ts =====
const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d{15,25}\/[\w-]{20,120}$/;
const isWebhookUrl = (u) => WEBHOOK_RE.test(u);
/** ส่งเข้า Discord Webhook (ต้อง await เสมอ เพราะบน Serverless ฟังก์ชันจะหยุดทันทีเมื่อตอบกลับ) */
async function send(url, body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
        if (!r.ok)
            logger.warn({ status: r.status }, "webhook ไม่สำเร็จ");
        return r.ok;
    }
    catch (err) {
        logger.warn({ err: String(err) }, "webhook error");
        return false;
    }
    finally {
        clearTimeout(t);
    }
}
async function postHook(key, embed, opts) {
    const { settings } = await getSettings();
    const url = settings[key];
    if (!url)
        return false;
    const body = { username: "JUKKINGDOM", embeds: [embed.toJSON()], allowed_mentions: { parse: [] } };
    if (opts?.mentionId && /^\d{15,25}$/.test(opts.mentionId)) {
        body.content = `<@${opts.mentionId}>`; // แท็กลูกค้าในห้องแจ้งสถานะ (ไม่มีบอท จึงส่ง DM ไม่ได้)
        body.allowed_mentions = { users: [opts.mentionId] };
    }
    return send(url, body);
}
/** แจ้งลูกค้าผ่านห้องสถานะ (แท็กชื่อลูกค้า) */
const dmUser = (discordId, embed) => postHook("statusWebhook", embed, { mentionId: discordId });
/** แจ้งทีมงาน/Log/รีวิว */
const postToChannel = (key, embed) => postHook(key === "orderChannelId" ? "orderWebhook" : key === "logChannelId" ? "logWebhook" : "reviewWebhook", embed);
// ===== services/orders.ts =====
class AppError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newOrderNo = () => "JK-" + Array.from((0, node_crypto_1.randomBytes)(6), (x) => ALPHABET[x % ALPHABET.length]).join("");
/** สร้างออเดอร์ใน Transaction เดียว กดซ้ำ (idempotencyKey เดิม) = ได้ออเดอร์เดิม */
async function createOrder(input) {
    const guild = await getGuild();
    const existing = await prisma.order.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing)
        return { order: existing, created: false };
    const pkg = await prisma.productPackage.findFirst({
        where: { id: input.packageId, active: true, deletedAt: null, product: { guildId: guild.id, active: true, deletedAt: null } },
    });
    if (!pkg)
        throw new AppError("PACKAGE_UNAVAILABLE", "แพ็กเกจนี้ไม่เปิดขายแล้ว");
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const order = await prisma.$transaction(async (tx) => {
                const user = await tx.user.upsert({
                    where: { discordId: input.customerDiscordId },
                    update: { username: input.customerName },
                    create: { discordId: input.customerDiscordId, username: input.customerName },
                });
                return tx.order.create({
                    data: {
                        orderNo: newOrderNo(), idempotencyKey: input.idempotencyKey, guildId: guild.id, customerId: user.id,
                        priceSatang: pkg.isCustom ? 0 : pkg.priceSatang, // ราคามาจากฐานข้อมูลเท่านั้น
                        budgetSatang: input.budgetSatang, details: input.details,
                        referenceLinks: input.referenceLinks, dueDate: input.dueDate,
                        items: { create: { packageId: pkg.id, nameSnapshot: pkg.name, priceSatang: pkg.priceSatang } },
                        history: { create: { toStatus: "PENDING", actorDiscordId: input.customerDiscordId, note: "ลูกค้าสร้างออเดอร์" } },
                    },
                });
            });
            await postToChannel("orderChannelId", brandEmbed().setTitle("ออเดอร์ใหม่ " + order.orderNo)
                .setDescription(`ลูกค้า <@${input.customerDiscordId}> สั่ง **${pkg.name}**\n${config.BASE_URL}/orders/${order.id}`));
            return { order, created: true };
        }
        catch (e) {
            if (e instanceof client_1.Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
                const dup = await prisma.order.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
                if (dup)
                    return { order: dup, created: false };
                continue; // เลขออเดอร์ชน -> สุ่มใหม่
            }
            throw e;
        }
    }
    throw new AppError("ORDER_NO_COLLISION", "สร้างเลขออเดอร์ไม่สำเร็จ");
}
/** เปลี่ยนสถานะ: ตรวจลำดับที่อนุญาต + ล็อกกันแก้พร้อมกัน + บันทึกประวัติ/Audit + แจ้งลูกค้า */
async function changeStatus(a) {
    const guild = await getGuild();
    const cur = await prisma.$transaction(async (tx) => {
        const o = await tx.order.findFirst({ where: { id: a.orderId, guildId: guild.id, deletedAt: null }, include: { customer: true } });
        if (!o)
            throw new AppError("NOT_FOUND", "ไม่พบออเดอร์");
        if (!TRANSITIONS[o.status].includes(a.to))
            throw new AppError("BAD_TRANSITION", `เปลี่ยนจาก "${ORDER_STATUS_TH[o.status]}" เป็น "${ORDER_STATUS_TH[a.to]}" ไม่ได้`);
        if (a.to === "CANCELLED" && !a.note?.trim())
            throw new AppError("REASON_REQUIRED", "ต้องระบุเหตุผลที่ยกเลิก");
        const upd = await tx.order.updateMany({
            where: { id: o.id, version: o.version },
            data: { status: a.to, version: { increment: 1 }, ...(a.to === "CANCELLED" ? { cancelReason: a.note } : {}) },
        });
        if (upd.count !== 1)
            throw new AppError("CONFLICT", "มีคนแก้ออเดอร์นี้พร้อมกัน กรุณารีเฟรชแล้วลองใหม่");
        await tx.orderStatusHistory.create({
            data: { orderId: o.id, fromStatus: o.status, toStatus: a.to, actorDiscordId: a.actorDiscordId, note: a.note || null },
        });
        await audit(tx, guild.id, a.actorDiscordId, "order.status", "Order", o.id, { status: o.status }, { status: a.to, note: a.note });
        return o;
    });
    const e = brandEmbed().setTitle(`อัปเดตออเดอร์ ${cur.orderNo}`)
        .setDescription(`สถานะใหม่: **${ORDER_STATUS_TH[a.to]}**${a.note ? `\nหมายเหตุ: ${a.note}` : ""}`);
    await dmUser(cur.customer.discordId, e);
    await postToChannel("logChannelId", brandEmbed().setTitle("เปลี่ยนสถานะ " + cur.orderNo)
        .setDescription(`${ORDER_STATUS_TH[cur.status]} → ${ORDER_STATUS_TH[a.to]} โดย <@${a.actorDiscordId}>`));
}
async function updateOrder(orderId, actorDiscordId, patch) {
    const guild = await getGuild();
    await prisma.$transaction(async (tx) => {
        const o = await tx.order.findFirst({ where: { id: orderId, guildId: guild.id, deletedAt: null } });
        if (!o)
            throw new AppError("NOT_FOUND", "ไม่พบออเดอร์");
        if (patch.priceSatang !== undefined && patch.priceSatang < o.paidSatang)
            throw new AppError("PRICE_LOW", "ราคาต้องไม่น้อยกว่ายอดที่ชำระแล้ว");
        if (patch.assigneeId) {
            const s = await tx.staffMember.findFirst({ where: { id: patch.assigneeId, guildId: guild.id, deletedAt: null } });
            if (!s)
                throw new AppError("BAD_ASSIGNEE", "ไม่พบทีมงานคนนี้");
        }
        const upd = await tx.order.updateMany({ where: { id: o.id, version: o.version }, data: { ...patch, version: { increment: 1 } } });
        if (upd.count !== 1)
            throw new AppError("CONFLICT", "มีคนแก้ออเดอร์นี้พร้อมกัน กรุณารีเฟรชแล้วลองใหม่");
        const before = {};
        const after = {};
        for (const k of Object.keys(patch)) {
            before[k] = o[k];
            after[k] = patch[k];
        }
        await audit(tx, guild.id, actorDiscordId, "order.update", "Order", o.id, before, after);
    });
}
/** บันทึกยอดที่ได้รับจริง (ทีมงานยืนยันเอง ระบบไม่เชื่อมธนาคาร/Payment Gateway) */
async function recordPayment(orderId, amountSatang, actorDiscordId, note) {
    const guild = await getGuild();
    if (!Number.isInteger(amountSatang) || amountSatang <= 0)
        throw new AppError("BAD_AMOUNT", "ยอดเงินไม่ถูกต้อง");
    const o = await prisma.$transaction(async (tx) => {
        const cur = await tx.order.findFirst({ where: { id: orderId, guildId: guild.id, deletedAt: null }, include: { customer: true } });
        if (!cur)
            throw new AppError("NOT_FOUND", "ไม่พบออเดอร์");
        if (cur.status === "CANCELLED")
            throw new AppError("CANCELLED", "ออเดอร์ที่ยกเลิกแล้วรับชำระไม่ได้");
        if (cur.priceSatang <= 0)
            throw new AppError("NO_PRICE", "ตั้งราคาออเดอร์ก่อนบันทึกยอดชำระ");
        const newPaid = cur.paidSatang + amountSatang;
        if (newPaid > cur.priceSatang)
            throw new AppError("OVERPAY", "ยอดรวมที่ชำระเกินราคาออเดอร์");
        const to = newPaid === cur.priceSatang ? "PAID" : "PARTIALLY_PAID";
        const upd = await tx.order.updateMany({
            where: { id: cur.id, version: cur.version },
            data: { paidSatang: newPaid, paymentStatus: to, version: { increment: 1 } },
        });
        if (upd.count !== 1)
            throw new AppError("CONFLICT", "มีคนแก้ออเดอร์นี้พร้อมกัน กรุณารีเฟรชแล้วลองใหม่");
        const p = await tx.payment.create({ data: { orderId: cur.id, customerId: cur.customerId, amountSatang, status: to } });
        await tx.paymentVerification.create({
            data: { paymentId: p.id, verifierDiscordId: actorDiscordId, fromStatus: cur.paymentStatus, toStatus: to, note: note || null },
        });
        await audit(tx, guild.id, actorDiscordId, "order.payment", "Order", cur.id, { paid: cur.paidSatang }, { paid: newPaid, amount: amountSatang });
        return { cur, newPaid, to };
    });
    await dmUser(o.cur.customer.discordId, brandEmbed().setTitle(`บันทึกการชำระเงิน ${o.cur.orderNo}`)
        .setDescription(`ได้รับ ${formatBaht(amountSatang)} (รวม ${formatBaht(o.newPaid)} / ${formatBaht(o.cur.priceSatang)})`));
}
/** ลูกค้าเห็นเฉพาะออเดอร์ของตัวเอง */
const listOrdersForCustomer = (customerDiscordId) => prisma.order.findMany({ where: { deletedAt: null, customer: { discordId: customerDiscordId } }, orderBy: { createdAt: "desc" }, take: 10 });
/** ลูกค้าแจ้งชำระเงิน (แนบลิงก์หลักฐาน) — ยังไม่นับเป็นยอดที่ชำระจนกว่าทีมงานจะยืนยัน */
async function submitPaymentProof(a) {
    const guild = await getGuild();
    if (!Number.isInteger(a.amountSatang) || a.amountSatang <= 0)
        throw new AppError("BAD_AMOUNT", "ยอดเงินไม่ถูกต้อง");
    if (!/^https:\/\/\S{4,480}$/.test(a.proofUrl))
        throw new AppError("BAD_URL", "ลิงก์หลักฐานต้องขึ้นต้นด้วย https://");
    const cur = await prisma.$transaction(async (tx) => {
        const o = await tx.order.findFirst({
            where: { orderNo: a.orderNo.trim().toUpperCase(), guildId: guild.id, deletedAt: null, customer: { discordId: a.customerDiscordId } },
        });
        if (!o)
            throw new AppError("NOT_FOUND", "ไม่พบออเดอร์นี้ในบัญชีของคุณ");
        if (o.status === "CANCELLED")
            throw new AppError("CANCELLED", "ออเดอร์ที่ยกเลิกแล้วแจ้งชำระเงินไม่ได้");
        if (o.priceSatang <= 0)
            throw new AppError("NO_PRICE", "ทีมงานยังไม่ได้ตั้งราคา กรุณารอการประเมินราคา");
        if (a.amountSatang > o.priceSatang - o.paidSatang)
            throw new AppError("OVERPAY", "ยอดเกินยอดคงเหลือของออเดอร์");
        const pending = await tx.payment.count({ where: { orderId: o.id, status: "PENDING_VERIFICATION" } });
        if (pending >= 3)
            throw new AppError("TOO_MANY", "มีหลักฐานรอตรวจสอบอยู่แล้ว กรุณารอทีมงาน");
        const p = await tx.payment.create({
            data: { orderId: o.id, customerId: o.customerId, amountSatang: a.amountSatang, status: "PENDING_VERIFICATION", proofUrl: a.proofUrl },
        });
        await tx.paymentVerification.create({
            data: { paymentId: p.id, verifierDiscordId: a.customerDiscordId, fromStatus: o.paymentStatus, toStatus: "PENDING_VERIFICATION", note: a.note || "ลูกค้าแจ้งชำระเงิน" },
        });
        if (o.paymentStatus === "UNPAID" || o.paymentStatus === "REJECTED")
            await tx.order.update({ where: { id: o.id }, data: { paymentStatus: "PENDING_VERIFICATION" } });
        return o;
    });
    await postToChannel("orderChannelId", brandEmbed().setTitle("แจ้งชำระเงิน " + cur.orderNo)
        .setDescription(`ลูกค้าแจ้งโอน ${formatBaht(a.amountSatang)} — ตรวจสอบที่ ${config.BASE_URL}/orders/${cur.id}`));
}
/** ทีมงานยืนยัน/ปฏิเสธหลักฐานการชำระเงิน */
async function verifyPayment(a) {
    const guild = await getGuild();
    const res = await prisma.$transaction(async (tx) => {
        const p = await tx.payment.findFirst({ where: { id: a.paymentId, order: { guildId: guild.id } }, include: { order: { include: { customer: true } } } });
        if (!p)
            throw new AppError("NOT_FOUND", "ไม่พบรายการชำระเงิน");
        if (p.status !== "PENDING_VERIFICATION")
            throw new AppError("DONE", "รายการนี้ตรวจสอบไปแล้ว");
        const o = p.order;
        let orderPay = o.paymentStatus;
        let newPaid = o.paidSatang;
        let payStatus;
        if (a.approve) {
            newPaid = o.paidSatang + p.amountSatang;
            if (newPaid > o.priceSatang)
                throw new AppError("OVERPAY", "ยอดรวมเกินราคาออเดอร์ (ตรวจราคาก่อน)");
            payStatus = newPaid === o.priceSatang ? "PAID" : "PARTIALLY_PAID";
            orderPay = payStatus;
        }
        else {
            if (!a.note?.trim())
                throw new AppError("REASON_REQUIRED", "ต้องระบุเหตุผลที่ปฏิเสธ");
            payStatus = "REJECTED";
            const others = await tx.payment.count({ where: { orderId: o.id, status: "PENDING_VERIFICATION", id: { not: p.id } } });
            if (!others && o.paymentStatus === "PENDING_VERIFICATION")
                orderPay = o.paidSatang > 0 ? "PARTIALLY_PAID" : "REJECTED";
        }
        const upd = await tx.order.updateMany({ where: { id: o.id, version: o.version }, data: { paidSatang: newPaid, paymentStatus: orderPay, version: { increment: 1 } } });
        if (upd.count !== 1)
            throw new AppError("CONFLICT", "มีคนแก้ออเดอร์นี้พร้อมกัน กรุณารีเฟรชแล้วลองใหม่");
        await tx.payment.update({ where: { id: p.id }, data: { status: payStatus } });
        await tx.paymentVerification.create({ data: { paymentId: p.id, verifierDiscordId: a.actorDiscordId, fromStatus: "PENDING_VERIFICATION", toStatus: payStatus, note: a.note || null } });
        await audit(tx, guild.id, a.actorDiscordId, a.approve ? "payment.approve" : "payment.reject", "Payment", p.id, { paid: o.paidSatang }, { paid: newPaid, amount: p.amountSatang });
        return { p, o, newPaid };
    });
    const e = brandEmbed().setTitle(`ผลตรวจสอบการชำระเงิน ${res.o.orderNo}`).setDescription(a.approve
        ? `ยืนยันยอด ${formatBaht(res.p.amountSatang)} แล้ว (รวม ${formatBaht(res.newPaid)} / ${formatBaht(res.o.priceSatang)})`
        : `หลักฐานไม่ผ่านการตรวจสอบ: ${a.note}`);
    await dmUser(res.o.customer.discordId, e);
}
/** ข้อความระหว่างลูกค้า-ทีมงานในออเดอร์ (ใช้แทนห้อง Ticket) */
async function addOrderMessage(a) {
    const guild = await getGuild();
    const content = a.content.trim();
    if (!content || content.length > 1000)
        throw new AppError("BAD", "ข้อความต้องยาว 1-1,000 ตัวอักษร");
    const o = await prisma.order.findFirst({
        where: {
            guildId: guild.id, deletedAt: null,
            ...(a.orderId ? { id: a.orderId } : { orderNo: (a.orderNo ?? "").trim().toUpperCase() }),
            ...(a.staff ? {} : { customer: { discordId: a.authorDiscordId } }), // ลูกค้าส่งได้เฉพาะออเดอร์ของตัวเอง
        },
        include: { customer: true },
    });
    if (!o)
        throw new AppError("NOT_FOUND", "ไม่พบออเดอร์");
    const last = await prisma.orderMessage.findFirst({ where: { orderId: o.id, authorDiscordId: a.authorDiscordId }, orderBy: { createdAt: "desc" } });
    if (last && Date.now() - last.createdAt.getTime() < 5000)
        throw new AppError("RATE", "ส่งข้อความถี่เกินไป กรุณารอสักครู่");
    await prisma.orderMessage.create({ data: { orderId: o.id, authorDiscordId: a.authorDiscordId, authorName: a.authorName.slice(0, 64), isStaff: a.staff, content } });
    const preview = content.slice(0, 300);
    if (a.staff)
        await dmUser(o.customer.discordId, brandEmbed().setTitle(`ข้อความจากทีมงาน — ${o.orderNo}`).setDescription(`${preview}\n${config.BASE_URL}/me/orders/${o.orderNo}`));
    else
        await postToChannel("orderChannelId", brandEmbed().setTitle(`ข้อความใหม่จากลูกค้า — ${o.orderNo}`).setDescription(`${preview}\n${config.BASE_URL}/orders/${o.id}`));
}
// ===== services/reviews.ts =====
async function createReview(a) {
    if (!Number.isInteger(a.rating) || a.rating < 1 || a.rating > 5)
        throw new AppError("BAD_RATING", "คะแนนต้อง 1-5");
    const guild = await getGuild();
    const o = await prisma.order.findFirst({
        where: { orderNo: a.orderNo.trim().toUpperCase(), guildId: guild.id, deletedAt: null, customer: { discordId: a.customerDiscordId } },
    });
    if (!o)
        throw new AppError("NOT_FOUND", "ไม่พบออเดอร์นี้ในบัญชีของคุณ");
    if (o.status !== "COMPLETED")
        throw new AppError("NOT_COMPLETED", "รีวิวได้เมื่อออเดอร์เสร็จสิ้นแล้วเท่านั้น");
    try {
        await prisma.review.create({
            data: { guildId: guild.id, orderId: o.id, customerId: o.customerId, rating: a.rating, comment: a.comment?.trim() || null },
        });
    }
    catch (e) {
        if (e instanceof client_1.Prisma.PrismaClientKnownRequestError && e.code === "P2002")
            throw new AppError("DUP", "ออเดอร์นี้รีวิวไปแล้ว");
        throw e;
    }
    await postToChannel("reviewChannelId", brandEmbed().setTitle(`รีวิวใหม่ ${"★".repeat(a.rating)}${"☆".repeat(5 - a.rating)}`)
        .setDescription(a.comment?.trim() || "(ไม่มีข้อความ)").addFields({ name: "ออเดอร์", value: o.orderNo }));
}
async function ratingSummary() {
    const guild = await getGuild();
    const r = await prisma.review.aggregate({ where: { guildId: guild.id, hidden: false }, _avg: { rating: true }, _count: true });
    return { avg: r._avg.rating, count: r._count };
}
// ===== web/html.ts =====
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NAV = [
    ["/dashboard", "ภาพรวม", "STAFF"], ["/orders", "ออเดอร์", "STAFF"], ["/packages", "แพ็กเกจ", "ADMIN"],
    ["/customers", "ลูกค้า", "ADMIN"], ["/reviews", "รีวิว", "ADMIN"], ["/settings", "ตั้งค่า", "ADMIN"],
    ["/staff", "ทีมงาน", "OWNER"], ["/audit", "Audit Log", "ADMIN"],
];
const LEVEL_TH = { OWNER: "เจ้าของ", ADMIN: "แอดมิน", STAFF: "ทีมงาน" };
const CSS = `
:root{--bg:#0b0b0c;--card:#161618;--line:#2a2a2e;--red:#8b0000;--red2:#e11d48;--text:#f4f4f5;--muted:#9ca3af;--ok:#16a34a;--warn:#d97706}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Noto Sans Thai",sans-serif}
a{color:#fca5a5}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--red2);outline-offset:2px}
header{background:#111113;border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;position:sticky;top:0;z-index:5}
.brand{font-weight:800;letter-spacing:.08em;color:#fff}.brand b{color:var(--red2)}
nav{display:flex;gap:4px;flex-wrap:wrap;flex:1}nav a{padding:6px 10px;border-radius:8px;text-decoration:none;color:var(--muted)}
nav a:hover{background:#1f1f22;color:#fff}nav a.on{background:var(--red);color:#fff}
.me{display:flex;gap:8px;align-items:center;color:var(--muted);font-size:13px}
main{max-width:1100px;margin:0 auto;padding:16px}h1{font-size:22px;margin:4px 0 14px}h2{font-size:17px;margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}.stat b{display:block;font-size:24px}.stat span{color:var(--muted);font-size:13px}
.wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:640px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;font-size:13px}
input,select,textarea{background:#0f0f11;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit;max-width:100%}
textarea{width:100%;min-height:70px}label{display:block;color:var(--muted);font-size:13px;margin:8px 0 3px}
button,.btn{background:var(--red);color:#fff;border:0;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}
button:hover{background:#a50000}.danger{background:var(--red2)}.ghost{background:#26262a}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:end}
.badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;border:1px solid var(--line);background:#1f1f22}
.b-ok{border-color:var(--ok);color:#86efac}.b-warn{border-color:var(--warn);color:#fcd34d}.b-bad{border-color:var(--red2);color:#fca5a5}
.msg{padding:10px 12px;border-radius:8px;margin-bottom:12px;border:1px solid}.msg.ok{border-color:var(--ok);color:#86efac}.msg.err{border-color:var(--red2);color:#fca5a5}
.muted{color:var(--muted)}.bars{display:flex;align-items:flex-end;gap:4px;height:90px}.bars div{flex:1;background:var(--red);border-radius:4px 4px 0 0;min-height:2px}
.pager{display:flex;gap:8px;margin-top:10px}details summary{cursor:pointer;color:#fca5a5}
@media(max-width:640px){main{padding:10px}}`;
function layout(o) {
    const nav = o.user ? NAV.filter(([, , min]) => atLeast(o.user.level, min))
        .map(([h, l]) => `<a href="${h}" class="${o.active === h ? "on" : ""}">${l}</a>`).join("") : "";
    const me = o.user ? `<div class="me"><span>${esc(o.user.name)} · ${LEVEL_TH[o.user.level] ?? ""}</span>
    <form method="post" action="/logout">${csrf(o.user)}<button class="ghost" type="submit">ออกจากระบบ</button></form></div>` : "";
    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)} · JUKKINGDOM</title><style>${CSS}</style></head><body>
<header><a class="brand" href="/" style="text-decoration:none">JUK<b>KINGDOM</b></a><nav aria-label="เมนูหลัก">${nav}</nav>${me}</header>
<main>${o.msg ? `<div class="msg ${o.msg.ok ? "ok" : "err"}" role="status">${esc(o.msg.text)}</div>` : ""}${o.body}</main></body></html>`;
}
const csrf = (u) => `<input type="hidden" name="_csrf" value="${esc(u.csrf)}">`;
const badge = (text, kind = "") => `<span class="badge ${kind ? "b-" + kind : ""}">${esc(text)}</span>`;
const orderBadge = (s, label) => badge(label, s === "COMPLETED" ? "ok" : s === "CANCELLED" ? "bad" : s === "PENDING" || s === "WAITING_CUSTOMER" ? "warn" : "");
const payBadge = (s, label) => badge(label, s === "PAID" ? "ok" : s === "REJECTED" ? "bad" : s === "UNPAID" ? "warn" : "");
function pager(base, page, hasNext) {
    const link = (p) => `${base}${base.includes("?") ? "&" : "?"}page=${p}`;
    return `<div class="pager">${page > 1 ? `<a class="btn ghost" href="${esc(link(page - 1))}">ก่อนหน้า</a>` : ""}<span class="muted">หน้า ${page}</span>${hasNext ? `<a class="btn ghost" href="${esc(link(page + 1))}">ถัดไป</a>` : ""}</div>`;
}
const loginPage = (err) => layout({
    title: "เข้าสู่ระบบ",
    body: `<div class="card" style="max-width:420px;margin:60px auto;text-align:center"><h1>JUKKINGDOM Dashboard</h1>
  <p class="muted">ลูกค้าและทีมงานเข้าสู่ระบบด้วยบัญชี Discord</p>${err ? `<p class="msg err">${esc(err)}</p>` : ""}
  <a class="btn" href="/login/start">เข้าสู่ระบบด้วย Discord</a></div>`,
});
const COOKIE = "jk_session";
const sign = (v) => (0, node_crypto_1.createHmac)("sha256", config.SESSION_SECRET).update(v).digest("base64url");
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && (0, node_crypto_1.timingSafeEqual)(x, y); };
function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i < 0)
            continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}
const cookieOpts = { httpOnly: true, sameSite: "lax", secure: config.NODE_ENV === "production", path: "/" };
function startSession(res, uid, name) {
    const payload = { uid, name, csrf: (0, node_crypto_1.randomBytes)(24).toString("base64url"), exp: Date.now() + 12 * 3600 * 1000 };
    const b = Buffer.from(JSON.stringify(payload)).toString("base64url");
    res.cookie(COOKIE, `${b}.${sign(b)}`, { ...cookieOpts, maxAge: 12 * 3600 * 1000 });
}
const endSession = (res) => res.clearCookie(COOKIE, cookieOpts);
function setStateCookie(res, state) { res.cookie("jk_state", state, { ...cookieOpts, maxAge: 10 * 60 * 1000 }); }
/** อ่าน Session แล้วตรวจสิทธิ์จากฐานข้อมูลทุกครั้ง (ถูกถอดสิทธิ์ = เข้าไม่ได้ทันที) */
async function loadUser(req, res, next) {
    const raw = parseCookies(req)[COOKIE];
    if (raw) {
        const [b, sig] = raw.split(".");
        if (b && sig && safeEq(sig, sign(b))) {
            try {
                const s = JSON.parse(Buffer.from(b, "base64url").toString());
                if (s.exp > Date.now()) {
                    req.session = s; // ล็อกอินแล้ว (ลูกค้าหรือทีมงาน)
                    const staff = await resolveStaff(s.uid);
                    if (staff)
                        req.user = { ...s, level: staff.role, staffId: staff.id };
                }
            }
            catch { /* session เสีย = ไม่ล็อกอิน */ }
        }
    }
    next();
}
const requireLevel = (min) => (req, res, next) => {
    if (!req.user) {
        if (req.session)
            return void res.status(403).send(layout({ title: "ไม่มีสิทธิ์", body: `<div class="card"><h1>ไม่มีสิทธิ์เข้าถึง</h1><p class="muted">หน้านี้สำหรับทีมงานเท่านั้น</p><p><a href="/">กลับหน้าร้าน</a></p></div>` }));
        return void res.redirect("/login");
    }
    if (!atLeast(req.user.level, min)) {
        return void res.status(403).send(layout({ title: "ไม่มีสิทธิ์", user: req.user, body: `<div class="card"><h1>ไม่มีสิทธิ์เข้าถึง</h1><p class="muted">หน้านี้สำหรับ ${esc(min)} ขึ้นไป</p></div>` }));
    }
    next();
};
/** ป้องกัน CSRF: ทุก POST ต้องแนบ token ที่ตรงกับ Session */
function csrfCheck(req, res, next) {
    if (req.method !== "POST" || req.path.startsWith("/login") || req.path.startsWith("/auth"))
        return next();
    const t = typeof req.body?._csrf === "string" ? req.body._csrf : "";
    if (!req.session || !safeEq(t, req.session.csrf))
        return void res.status(403).send("คำขอไม่ถูกต้อง (CSRF) กรุณารีเฟรชหน้า");
    next();
}
function setNextCookie(res, path) {
    if (/^\/(?!\/)[\w\-./?=&%]*$/.test(path))
        res.cookie("jk_next", path, { ...cookieOpts, maxAge: 10 * 60 * 1000 });
}
const requireLogin = (req, res, next) => {
    if (req.session)
        return next();
    setNextCookie(res, req.originalUrl);
    res.redirect("/login");
};
// ===== web/util.ts =====
const str = (v) => (typeof v === "string" ? v.trim() : "");
const flash = (req) => {
    const t = str(req.query.msg);
    return t ? { text: t, ok: str(req.query.ok) === "1" } : undefined;
};
const back = (res, url, text, ok) => res.redirect(`${url}${url.includes("?") ? "&" : "?"}msg=${encodeURIComponent(text)}&ok=${ok ? 1 : 0}`);
/** รัน action แล้ว redirect กลับพร้อมข้อความ (AppError = แจ้งผู้ใช้, อื่น ๆ = log แล้วแจ้งทั่วไป) */
async function act(res, url, okText, fn) {
    try {
        await fn();
        back(res, url, okText, true);
    }
    catch (e) {
        if (e instanceof AppError)
            return void back(res, url, e.message, false);
        logger.error({ err: e }, "web action failed");
        back(res, url, "ระบบขัดข้อง กรุณาลองใหม่", false);
    }
}
const dateInput = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T00:00:00+07:00") : null);
// ===== web/auth.ts =====
const authRouter = (0, express_1.Router)();
const redirectUri = `${config.BASE_URL}/auth/callback`;
// จำกัดความถี่ล็อกอินต่อ IP (ในหน่วยความจำ)
const hits = new Map();
function limited(ip) {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.t > 60_000) {
        hits.set(ip, { n: 1, t: now });
        return false;
    }
    return ++h.n > 15;
}
authRouter.get("/login", (req, res) => (req.session ? res.redirect(req.user ? "/dashboard" : "/me") : res.send(loginPage())));
authRouter.get("/login/start", (req, res) => {
    if (limited(req.ip ?? ""))
        return void res.status(429).send("ลองใหม่ภายหลัง");
    const state = (0, node_crypto_1.randomBytes)(16).toString("hex");
    setStateCookie(res, state);
    if (typeof req.query.next === "string")
        setNextCookie(res, req.query.next);
    const q = new URLSearchParams({ client_id: config.DISCORD_CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: "identify", state });
    res.redirect(`https://discord.com/oauth2/authorize?${q}`);
});
authRouter.get("/auth/callback", async (req, res) => {
    try {
        if (limited(req.ip ?? ""))
            return void res.status(429).send("ลองใหม่ภายหลัง");
        const code = typeof req.query.code === "string" ? req.query.code : "";
        const state = typeof req.query.state === "string" ? req.query.state : "";
        if (!code || !state || state !== parseCookies(req)["jk_state"])
            return void res.status(400).send(loginPage("การเข้าสู่ระบบไม่ถูกต้อง กรุณาลองใหม่"));
        res.clearCookie("jk_state", { path: "/" });
        const tok = await fetch("https://discord.com/api/oauth2/token", {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: config.DISCORD_CLIENT_ID, client_secret: config.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: redirectUri }),
        });
        if (!tok.ok)
            return void res.status(400).send(loginPage("ล็อกอินกับ Discord ไม่สำเร็จ"));
        const { access_token } = (await tok.json());
        const me = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${access_token}` } });
        if (!me.ok)
            return void res.status(400).send(loginPage("ดึงข้อมูลผู้ใช้ไม่สำเร็จ"));
        const u = (await me.json());
        const staff = await resolveStaff(u.id);
        startSession(res, u.id, u.global_name || u.username);
        const next = parseCookies(req)["jk_next"];
        res.clearCookie("jk_next", { path: "/" });
        res.redirect(next && /^\/(?!\/)/.test(next) ? next : staff ? "/dashboard" : "/me");
    }
    catch (err) {
        logger.error({ err }, "oauth callback failed");
        res.status(500).send(loginPage("เกิดข้อผิดพลาด กรุณาลองใหม่"));
    }
});
authRouter.post("/logout", (req, res) => { endSession(res); res.redirect("/login"); });
// ===== web/routes/overview.ts =====
const overviewRouter = (0, express_1.Router)();
overviewRouter.get("/dashboard", requireLevel("STAFF"), async (req, res) => {
    const u = req.user;
    const g = await getGuild();
    const base = { guildId: g.id, deletedAt: null };
    const soon = new Date(Date.now() + 3 * 86400_000);
    const since = new Date(Date.now() - 13 * 86400_000);
    since.setHours(0, 0, 0, 0);
    const [byStatus, paid, customers, rating, due, recent, last14] = await Promise.all([
        prisma.order.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
        prisma.order.aggregate({ where: { ...base, status: { not: "CANCELLED" } }, _sum: { paidSatang: true } }),
        prisma.user.count({ where: { orders: { some: { guildId: g.id } } } }),
        ratingSummary(),
        prisma.order.findMany({ where: { ...base, dueDate: { lte: soon }, status: { notIn: ["COMPLETED", "CANCELLED"] } }, orderBy: { dueDate: "asc" }, take: 8, include: { customer: true } }),
        prisma.orderStatusHistory.findMany({ where: { order: { guildId: g.id } }, orderBy: { createdAt: "desc" }, take: 10, include: { order: true } }),
        prisma.order.findMany({ where: { ...base, createdAt: { gte: since } }, select: { createdAt: true } }),
    ]);
    const c = (s) => byStatus.find((x) => x.status === s)?._count._all ?? 0;
    const total = byStatus.reduce((a, x) => a + x._count._all, 0);
    const inprog = c("CONFIRMED") + c("IN_PROGRESS") + c("WAITING_CUSTOMER") + c("REVISION");
    const days = [];
    for (let k = 13; k >= 0; k--) {
        const d = new Date(Date.now() - k * 86400_000);
        const key = d.toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
        days.push({ label: key.slice(5), n: last14.filter((o) => o.createdAt.toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" }) === key).length });
    }
    const max = Math.max(1, ...days.map((d) => d.n));
    const stat = (n, l) => `<div class="stat"><b>${esc(n)}</b><span>${esc(l)}</span></div>`;
    res.send(layout({ title: "ภาพรวม", user: u, active: "/dashboard", body: `
<h1>ภาพรวมร้าน</h1>
<div class="grid">${stat(total, "ออเดอร์ทั้งหมด")}${stat(c("PENDING"), "ออเดอร์ใหม่ (รอตรวจสอบ)")}${stat(inprog, "กำลังดำเนินการ")}
${stat(c("COMPLETED"), "เสร็จสิ้น")}${stat(c("CANCELLED"), "ยกเลิก")}${stat(customers, "ลูกค้า")}
${stat(rating.count ? `${rating.avg.toFixed(2)} (${rating.count})` : "-", "คะแนนรีวิวเฉลี่ย")}
${atLeast(u.level, "ADMIN") ? stat(formatBaht(paid._sum.paidSatang ?? 0), "รายรับที่บันทึกไว้") : ""}</div>
<div class="card" style="margin-top:14px"><h2>ออเดอร์ใหม่ 14 วันล่าสุด</h2>
<div class="bars" role="img" aria-label="กราฟจำนวนออเดอร์รายวัน">${days.map((d) => `<div title="${esc(d.label)}: ${d.n}" style="height:${Math.round((d.n / max) * 100)}%"></div>`).join("")}</div>
<div class="muted" style="font-size:12px">${esc(days[0].label)} → ${esc(days[13].label)} (สูงสุด ${max}/วัน)</div></div>
<div class="card"><h2>งานใกล้ถึงกำหนดส่ง (3 วัน)</h2>${due.length ? `<div class="wrap"><table><tr><th>ออเดอร์</th><th>ลูกค้า</th><th>สถานะ</th><th>กำหนดส่ง</th></tr>
${due.map((o) => `<tr><td><a href="/orders/${esc(o.id)}">${esc(o.orderNo)}</a></td><td>${esc(o.customer.username)}</td><td>${orderBadge(o.status, ORDER_STATUS_TH[o.status])}</td><td>${thDay(o.dueDate)}</td></tr>`).join("")}</table></div>` : `<p class="muted">ไม่มีงานใกล้ถึงกำหนด</p>`}</div>
<div class="card"><h2>กิจกรรมล่าสุด</h2>${recent.length ? `<div class="wrap"><table><tr><th>เวลา</th><th>ออเดอร์</th><th>สถานะ</th><th>หมายเหตุ</th></tr>
${recent.map((h) => `<tr><td>${thDate(h.createdAt)}</td><td><a href="/orders/${esc(h.orderId)}">${esc(h.order.orderNo)}</a></td><td>${esc(ORDER_STATUS_TH[h.toStatus])}</td><td>${esc(h.note ?? "")}</td></tr>`).join("")}</table></div>` : `<p class="muted">ยังไม่มีกิจกรรม</p>`}</div>` }));
});
// ===== web/routes/orders.ts =====
const ordersRouter = (0, express_1.Router)();
ordersRouter.use("/orders", requireLevel("STAFF"));
const ORDERS_PAGE = 20;
ordersRouter.get("/orders", async (req, res) => {
    const u = req.user;
    const g = await getGuild();
    const q = str(req.query.q), status = str(req.query.status), from = str(req.query.from), to = str(req.query.to);
    const page = Math.max(1, parseInt(str(req.query.page)) || 1);
    const and = [];
    if (q)
        and.push({ OR: [{ orderNo: { contains: q.toUpperCase() } }, { customer: { username: { contains: q, mode: "insensitive" } } }] });
    if (status in ORDER_STATUS_TH)
        and.push({ status: status });
    const f = dateInput(from), t = dateInput(to);
    if (f)
        and.push({ createdAt: { gte: f } });
    if (t)
        and.push({ createdAt: { lt: new Date(t.getTime() + 86400_000) } });
    if (u.level === "STAFF")
        and.push({ OR: [{ assigneeId: null }, { assigneeId: u.staffId }] });
    const where = { guildId: g.id, deletedAt: null, AND: and };
    const rows = await prisma.order.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * ORDERS_PAGE, take: ORDERS_PAGE + 1, include: { customer: true, items: true } });
    const qsBase = `/orders?${new URLSearchParams({ q, status, from, to })}`;
    res.send(layout({ title: "ออเดอร์", user: u, active: "/orders", msg: flash(req), body: `<h1>ออเดอร์</h1>
<form class="card row" method="get" action="/orders">
<div><label for="q">ค้นหา (เลขออเดอร์/ชื่อลูกค้า)</label><input id="q" name="q" value="${esc(q)}"></div>
<div><label for="st">สถานะ</label><select id="st" name="status"><option value="">ทั้งหมด</option>${Object.entries(ORDER_STATUS_TH).map(([k, v]) => `<option value="${k}" ${k === status ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></div>
<div><label for="f">จากวันที่</label><input id="f" type="date" name="from" value="${esc(from)}"></div>
<div><label for="t">ถึงวันที่</label><input id="t" type="date" name="to" value="${esc(to)}"></div><button type="submit">ค้นหา</button></form>
<div class="card wrap">${rows.length ? `<table><tr><th>เลขออเดอร์</th><th>ลูกค้า</th><th>แพ็กเกจ</th><th>สถานะ</th><th>ชำระเงิน</th><th>ราคา</th><th>กำหนดส่ง</th><th>สร้างเมื่อ</th></tr>
${rows.slice(0, ORDERS_PAGE).map((o) => `<tr><td><a href="/orders/${esc(o.id)}">${esc(o.orderNo)}</a></td><td>${esc(o.customer.username)}</td><td>${esc(o.items[0]?.nameSnapshot ?? "-")}</td>
<td>${orderBadge(o.status, ORDER_STATUS_TH[o.status])}</td><td>${payBadge(o.paymentStatus, PAYMENT_STATUS_TH[o.paymentStatus])}</td><td>${o.priceSatang ? formatBaht(o.priceSatang) : "-"}</td><td>${thDay(o.dueDate)}</td><td>${thDate(o.createdAt)}</td></tr>`).join("")}</table>` : `<p class="muted">ไม่พบออเดอร์</p>`}</div>
${pager(qsBase, page, rows.length > ORDERS_PAGE)}` }));
});
ordersRouter.get("/orders/:id", async (req, res) => {
    const u = req.user;
    const g = await getGuild();
    const o = await prisma.order.findFirst({
        where: { id: req.params.id, guildId: g.id, deletedAt: null },
        include: { customer: true, items: true, assignee: true, history: { orderBy: { createdAt: "desc" } }, payments: { orderBy: { createdAt: "desc" } }, review: true, messages: { orderBy: { createdAt: "asc" }, take: 200 } },
    });
    if (!o || (u.level === "STAFF" && o.assigneeId && o.assigneeId !== u.staffId))
        return void res.status(404).send(layout({ title: "ไม่พบ", user: u, body: `<div class="card"><h1>ไม่พบออเดอร์</h1></div>` }));
    const admin = atLeast(u.level, "ADMIN");
    const canManage = admin || o.assigneeId === u.staffId;
    const staff = admin ? await prisma.staffMember.findMany({ where: { guildId: g.id, deletedAt: null }, orderBy: { createdAt: "asc" } }) : [];
    const url = `/orders/${o.id}`;
    const form = (action, inner, btn, cls = "") => `<form method="post" action="${url}/${action}" class="row" style="margin-top:8px">${csrf(u)}${inner}<button class="${cls}" type="submit">${btn}</button></form>`;
    const next = TRANSITIONS[o.status];
    res.send(layout({ title: o.orderNo, user: u, active: "/orders", msg: flash(req), body: `
<p><a href="/orders">← ออเดอร์ทั้งหมด</a></p><h1>${esc(o.orderNo)} ${orderBadge(o.status, ORDER_STATUS_TH[o.status])} ${payBadge(o.paymentStatus, PAYMENT_STATUS_TH[o.paymentStatus])}</h1>
<div class="card"><div class="grid">
<div><span class="muted">ลูกค้า</span><br>${esc(o.customer.username)}<br><span class="muted">${esc(o.customer.discordId)}</span></div>
<div><span class="muted">แพ็กเกจ</span><br>${esc(o.items.map((i) => i.nameSnapshot).join(", "))}</div>
<div><span class="muted">ราคา / ชำระแล้ว</span><br>${o.priceSatang ? formatBaht(o.priceSatang) : "ยังไม่ตั้งราคา"} / ${formatBaht(o.paidSatang)}</div>
<div><span class="muted">งบลูกค้า</span><br>${o.budgetSatang ? formatBaht(o.budgetSatang) : "-"}</div>
<div><span class="muted">กำหนดส่ง</span><br>${thDay(o.dueDate)}</div>
<div><span class="muted">ผู้รับผิดชอบ</span><br>${o.assignee ? esc(o.assignee.discordId) : "ยังไม่มี"}</div></div>
<h2 style="margin-top:14px">รายละเอียดงาน</h2><p style="white-space:pre-wrap">${esc(o.details)}</p>
${o.referenceLinks.length ? `<p>${o.referenceLinks.map((l) => `<a href="${esc(l)}" rel="noopener noreferrer nofollow" target="_blank">${esc(l)}</a>`).join("<br>")}</p>` : ""}
${o.cancelReason ? `<p class="msg err">เหตุผลที่ยกเลิก: ${esc(o.cancelReason)}</p>` : ""}
${o.review ? `<p>รีวิว: ${"★".repeat(o.review.rating)}${"☆".repeat(5 - o.review.rating)} ${esc(o.review.comment ?? "")}${o.review.hidden ? " (ซ่อนอยู่)" : ""}</p>` : ""}</div>
<div class="card"><h2>จัดการงาน</h2>
${!o.assigneeId && !admin ? form("assign", `<input type="hidden" name="assigneeId" value="self">`, "รับงานนี้") : ""}
${canManage ? (next.length ? form("status", `<div><label for="to">เปลี่ยนสถานะเป็น</label><select id="to" name="to">${next.map((s) => `<option value="${s}">${esc(ORDER_STATUS_TH[s])}</option>`).join("")}</select></div>
<div><label for="n">หมายเหตุ (ต้องใส่ถ้ายกเลิก)</label><input id="n" name="note" maxlength="300"></div>`, "บันทึกสถานะ และแจ้งลูกค้า") : `<p class="muted">ออเดอร์นี้เปลี่ยนสถานะต่อไม่ได้</p>`) : `<p class="muted">คุณจัดการได้เฉพาะงานที่รับผิดชอบ (กด "รับงานนี้" ก่อน)</p>`}
${canManage ? form("note", `<div style="flex:1;min-width:240px"><label for="in">หมายเหตุภายใน (ลูกค้าไม่เห็น)</label><input id="in" name="internalNote" maxlength="500" value="${esc(o.internalNote ?? "")}" style="width:100%"></div>`, "บันทึกหมายเหตุ", "ghost") : ""}
${canManage ? form("due", `<div><label for="d">วันส่งงาน</label><input id="d" type="date" name="due" value="${o.dueDate ? o.dueDate.toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" }) : ""}"></div>`, "บันทึกวันส่ง", "ghost") : ""}
${admin ? form("price", `<div><label for="p">ราคา (บาท)</label><input id="p" name="price" inputmode="decimal" value="${satangToInput(o.priceSatang)}"></div>`, "บันทึกราคา", "ghost") : ""}
${admin ? form("assign", `<div><label for="as">ผู้รับผิดชอบ</label><select id="as" name="assigneeId"><option value="">ไม่กำหนด</option>${staff.map((s) => `<option value="${esc(s.id)}" ${s.id === o.assigneeId ? "selected" : ""}>${esc(s.discordId)} (${esc(s.role)})</option>`).join("")}</select></div>`, "กำหนดผู้รับผิดชอบ", "ghost") : ""}</div>
${admin ? `<div class="card"><h2>บันทึกการชำระเงิน</h2><p class="muted">ทีมงานตรวจยอดเองก่อนบันทึก (ระบบไม่ได้เชื่อมต่อธนาคาร)</p>
${form("payment", `<div><label for="a">ยอดที่ได้รับ (บาท)</label><input id="a" name="amount" inputmode="decimal" required></div><div><label for="pn">หมายเหตุ</label><input id="pn" name="note" maxlength="200"></div>`, "บันทึกยอด")}
${o.payments.length ? `<div class="wrap"><table><tr><th>เวลา</th><th>ยอด</th><th>สถานะ</th><th>หลักฐาน</th><th>ตรวจสอบ</th></tr>${o.payments.map((p) => `<tr><td>${thDate(p.createdAt)}</td><td>${formatBaht(p.amountSatang)}</td><td>${esc(PAYMENT_STATUS_TH[p.status])}</td>
<td>${p.proofUrl ? `<a href="${esc(p.proofUrl)}" rel="noopener noreferrer nofollow" target="_blank">เปิดดู</a>` : "-"}</td>
<td>${p.status === "PENDING_VERIFICATION" ? `<form method="post" action="${url}/payments/${esc(p.id)}/approve" style="display:inline">${csrf(u)}<button type="submit">ยืนยันยอด</button></form>
<form method="post" action="${url}/payments/${esc(p.id)}/reject" class="row" style="margin-top:6px">${csrf(u)}<input name="note" placeholder="เหตุผลที่ปฏิเสธ" required maxlength="200"><button class="danger" type="submit">ปฏิเสธ</button></form>` : ""}</td></tr>`).join("")}</table></div>` : ""}</div>` : ""}
<div class="card"><h2>ข้อความกับลูกค้า</h2>${o.messages.length ? o.messages.map((m) => `<p style="margin:6px 0"><b>${m.isStaff ? "ทีมงาน" : esc(o.customer.username)}</b> <span class="muted">· ${thDate(m.createdAt)}</span><br><span style="white-space:pre-wrap">${esc(m.content)}</span></p>`).join("") : `<p class="muted">ยังไม่มีข้อความ</p>`}
${canManage ? form("message", `<div style="flex:1;min-width:240px"><label for="msg">ตอบลูกค้า (ลูกค้าจะถูกแท็กในห้องแจ้งสถานะ)</label><input id="msg" name="content" maxlength="1000" required style="width:100%"></div>`, "ส่งข้อความ") : ""}</div>
<div class="card"><h2>ประวัติการเปลี่ยนแปลง</h2><div class="wrap"><table><tr><th>เวลา</th><th>จาก</th><th>เป็น</th><th>โดย (Discord ID)</th><th>หมายเหตุ</th></tr>
${o.history.map((h) => `<tr><td>${thDate(h.createdAt)}</td><td>${h.fromStatus ? esc(ORDER_STATUS_TH[h.fromStatus]) : "-"}</td><td>${esc(ORDER_STATUS_TH[h.toStatus])}</td><td>${esc(h.actorDiscordId)}</td><td>${esc(h.note ?? "")}</td></tr>`).join("")}</table></div></div>` }));
});
/** ตรวจสิทธิ์ฝั่งเซิร์ฟเวอร์ก่อนทุก action: ADMIN+ จัดการได้ทั้งหมด, STAFF เฉพาะงานที่ตนรับผิดชอบ */
async function authorize(req, orderId, needAdmin = false) {
    const u = req.user;
    const g = await getGuild();
    const o = await prisma.order.findFirst({ where: { id: orderId, guildId: g.id, deletedAt: null } });
    if (!o)
        throw new AppError("NOT_FOUND", "ไม่พบออเดอร์");
    const admin = atLeast(u.level, "ADMIN");
    if (needAdmin && !admin)
        throw new AppError("FORBIDDEN", "ต้องเป็นแอดมินขึ้นไป");
    if (!admin && o.assigneeId !== u.staffId)
        throw new AppError("FORBIDDEN", "คุณไม่ได้รับผิดชอบงานนี้");
    return u;
}
ordersRouter.post("/orders/:id/status", async (req, res) => {
    const url = `/orders/${req.params.id}`;
    await act(res, url, "เปลี่ยนสถานะแล้ว และแจ้งลูกค้าแล้ว", async () => {
        const u = await authorize(req, req.params.id);
        const to = str(req.body.to);
        if (!(to in ORDER_STATUS_TH))
            throw new AppError("BAD", "สถานะไม่ถูกต้อง");
        await changeStatus({ orderId: req.params.id, to, actorDiscordId: u.uid, note: str(req.body.note).slice(0, 300) });
    });
});
ordersRouter.post("/orders/:id/note", async (req, res) => {
    await act(res, `/orders/${req.params.id}`, "บันทึกแล้ว", async () => {
        const u = await authorize(req, req.params.id);
        await updateOrder(req.params.id, u.uid, { internalNote: str(req.body.internalNote).slice(0, 500) || null });
    });
});
ordersRouter.post("/orders/:id/due", async (req, res) => {
    await act(res, `/orders/${req.params.id}`, "บันทึกวันส่งงานแล้ว", async () => {
        const u = await authorize(req, req.params.id);
        const raw = str(req.body.due);
        const d = raw ? dateInput(raw) : null;
        if (raw && !d)
            throw new AppError("BAD", "วันที่ไม่ถูกต้อง");
        await updateOrder(req.params.id, u.uid, { dueDate: d });
    });
});
ordersRouter.post("/orders/:id/price", async (req, res) => {
    await act(res, `/orders/${req.params.id}`, "บันทึกราคาแล้ว", async () => {
        const u = await authorize(req, req.params.id, true);
        const p = bahtToSatang(str(req.body.price));
        if (p === null)
            throw new AppError("BAD", "ราคาไม่ถูกต้อง");
        await updateOrder(req.params.id, u.uid, { priceSatang: p });
    });
});
ordersRouter.post("/orders/:id/assign", async (req, res) => {
    await act(res, `/orders/${req.params.id}`, "บันทึกผู้รับผิดชอบแล้ว", async () => {
        const u = req.user;
        const g = await getGuild();
        const o = await prisma.order.findFirst({ where: { id: req.params.id, guildId: g.id, deletedAt: null } });
        if (!o)
            throw new AppError("NOT_FOUND", "ไม่พบออเดอร์");
        const v = str(req.body.assigneeId);
        if (atLeast(u.level, "ADMIN")) {
            await updateOrder(o.id, u.uid, { assigneeId: v === "self" ? u.staffId : v || null });
        }
        else {
            // STAFF: รับงานที่ยังไม่มีผู้รับผิดชอบได้เท่านั้น
            if (v !== "self" || o.assigneeId)
                throw new AppError("FORBIDDEN", "รับได้เฉพาะงานที่ยังไม่มีผู้รับผิดชอบ");
            await updateOrder(o.id, u.uid, { assigneeId: u.staffId });
        }
    });
});
ordersRouter.post("/orders/:id/payment", async (req, res) => {
    await act(res, `/orders/${req.params.id}`, "บันทึกยอดแล้ว", async () => {
        const u = await authorize(req, req.params.id, true);
        const a = bahtToSatang(str(req.body.amount));
        if (a === null)
            throw new AppError("BAD", "ยอดเงินไม่ถูกต้อง");
        await recordPayment(req.params.id, a, u.uid, str(req.body.note).slice(0, 200));
    });
});
ordersRouter.post("/orders/:id/payments/:pid/:op", async (req, res) => {
    await act(res, `/orders/${req.params.id}`, "บันทึกผลการตรวจสอบแล้ว และแจ้งลูกค้าแล้ว", async () => {
        const u = await authorize(req, req.params.id, true);
        const op = req.params.op;
        if (op !== "approve" && op !== "reject")
            throw new AppError("BAD", "คำสั่งไม่ถูกต้อง");
        await verifyPayment({ paymentId: req.params.pid, approve: op === "approve", actorDiscordId: u.uid, note: str(req.body.note).slice(0, 200) });
    });
});
ordersRouter.post("/orders/:id/message", async (req, res) => {
    await act(res, `/orders/${req.params.id}`, "ส่งข้อความแล้ว", async () => {
        const u = await authorize(req, req.params.id);
        await addOrderMessage({ orderId: req.params.id, authorDiscordId: u.uid, authorName: u.name, content: str(req.body.content), staff: true });
    });
});
// ===== web/routes/packages.ts =====
const packagesRouter = (0, express_1.Router)();
packagesRouter.use("/packages", requireLevel("ADMIN"));
const pkgSchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(1, "ใส่ชื่อแพ็กเกจ").max(80),
    description: zod_1.z.string().trim().max(500).optional().transform((v) => v || null),
    price: zod_1.z.string().trim().default("0"),
    etaDays: zod_1.z.string().trim().optional().transform((v) => (v ? parseInt(v, 10) : null)).pipe(zod_1.z.number().int().min(1).max(365).nullable()),
    coverUrl: zod_1.z.string().trim().optional().transform((v) => v || null).pipe(zod_1.z.string().url().startsWith("https://", "ภาพปกต้องเป็นลิงก์ https://").nullable()),
    inclusions: zod_1.z.string().optional().transform((v) => (v ?? "").split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 15)),
    sortOrder: zod_1.z.string().trim().optional().transform((v) => (v ? parseInt(v, 10) : 0)).pipe(zod_1.z.number().int().min(0).max(9999)),
});
function parse(body) {
    const r = pkgSchema.safeParse(body);
    if (!r.success)
        throw new AppError("BAD", r.error.issues[0].message);
    const price = bahtToSatang(r.data.price);
    if (price === null)
        throw new AppError("BAD", "ราคาไม่ถูกต้อง");
    return { ...r.data, priceSatang: price, isCustom: body.isCustom === "on", active: body.active === "on" };
}
async function defaultProduct(guildId) {
    return (await prisma.product.findFirst({ where: { guildId, deletedAt: null }, orderBy: { createdAt: "asc" } }))
        ?? prisma.product.create({ data: { guildId, name: "บริการตกแต่งเซิร์ฟเวอร์" } });
}
const fields = (p) => `
<div class="row"><div><label>ชื่อแพ็กเกจ</label><input name="name" required maxlength="80" value="${esc(p?.name)}"></div>
<div><label>ราคา (บาท)</label><input name="price" inputmode="decimal" value="${p ? satangToInput(p.priceSatang) : "0"}"></div>
<div><label>ระยะเวลา (วัน)</label><input name="etaDays" inputmode="numeric" value="${esc(p?.etaDays ?? "")}"></div>
<div><label>ลำดับแสดง</label><input name="sortOrder" inputmode="numeric" value="${esc(p?.sortOrder ?? 0)}"></div></div>
<label>รายละเอียด</label><input name="description" maxlength="500" style="width:100%" value="${esc(p?.description)}">
<label>ภาพปก (ลิงก์ https://)</label><input name="coverUrl" style="width:100%" value="${esc(p?.coverUrl)}">
<label>สิ่งที่ลูกค้าจะได้รับ (บรรทัดละข้อ)</label><textarea name="inclusions">${esc(p?.inclusions.join("\n"))}</textarea>
<label><input type="checkbox" name="isCustom" ${p?.isCustom ? "checked" : ""}> แพ็กเกจกำหนดเอง (ราคาตามตกลง)</label>
<label><input type="checkbox" name="active" ${!p || p.active ? "checked" : ""}> เปิดขาย</label>`;
packagesRouter.get("/packages", async (req, res) => {
    const u = req.user;
    const g = await getGuild();
    const list = await prisma.productPackage.findMany({ where: { deletedAt: null, product: { guildId: g.id, deletedAt: null } }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    res.send(layout({ title: "แพ็กเกจ", user: u, active: "/packages", msg: flash(req), body: `<h1>แพ็กเกจบริการ</h1>
<div class="card"><h2>เพิ่มแพ็กเกจ</h2><form method="post" action="/packages">${csrf(u)}${fields()}<p><button type="submit">เพิ่มแพ็กเกจ</button></p></form></div>
${list.length ? list.map((p) => `<div class="card"><details><summary>${esc(p.name)} — ${p.isCustom ? "ตามตกลง" : formatBaht(p.priceSatang)} ${p.active ? badge("เปิดขาย", "ok") : badge("ปิดขาย", "warn")}</summary>
<form method="post" action="/packages/${esc(p.id)}">${csrf(u)}${fields(p)}<div class="row" style="margin-top:10px"><button type="submit">บันทึก</button></div></form>
<form method="post" action="/packages/${esc(p.id)}/delete" onsubmit="return confirm('ลบแพ็กเกจนี้? (ออเดอร์เดิมยังเก็บไว้)')" style="margin-top:8px">${csrf(u)}<button class="danger" type="submit">ลบแพ็กเกจ</button></form></details></div>`).join("") : `<p class="muted">ยังไม่มีแพ็กเกจ</p>`}` }));
});
packagesRouter.post("/packages", async (req, res) => {
    await act(res, "/packages", "เพิ่มแพ็กเกจแล้ว", async () => {
        const d = parse(req.body);
        const g = await getGuild();
        const prod = await defaultProduct(g.id);
        const { price: _p, ...data } = d;
        const p = await prisma.productPackage.create({ data: { ...data, productId: prod.id } });
        await audit(prisma, g.id, req.user.uid, "package.create", "ProductPackage", p.id, undefined, { name: p.name, priceSatang: p.priceSatang });
    });
});
packagesRouter.post("/packages/:id", async (req, res) => {
    await act(res, "/packages", "บันทึกแพ็กเกจแล้ว", async () => {
        const d = parse(req.body);
        const g = await getGuild();
        const old = await prisma.productPackage.findFirst({ where: { id: req.params.id, deletedAt: null, product: { guildId: g.id } } });
        if (!old)
            throw new AppError("NOT_FOUND", "ไม่พบแพ็กเกจ");
        const { price: _p, ...data } = d;
        await prisma.productPackage.update({ where: { id: old.id }, data });
        await audit(prisma, g.id, req.user.uid, "package.update", "ProductPackage", old.id, { name: old.name, priceSatang: old.priceSatang, active: old.active }, { name: data.name, priceSatang: data.priceSatang, active: data.active });
    });
});
packagesRouter.post("/packages/:id/delete", async (req, res) => {
    await act(res, "/packages", "ลบแพ็กเกจแล้ว", async () => {
        const g = await getGuild();
        const r = await prisma.productPackage.updateMany({ where: { id: req.params.id, deletedAt: null, product: { guildId: g.id } }, data: { deletedAt: new Date(), active: false } });
        if (r.count !== 1)
            throw new AppError("NOT_FOUND", "ไม่พบแพ็กเกจ");
        await audit(prisma, g.id, req.user.uid, "package.delete", "ProductPackage", req.params.id);
    });
});
// ===== web/routes/people.ts =====
const peopleRouter = (0, express_1.Router)();
peopleRouter.use(["/customers", "/reviews"], requireLevel("ADMIN"));
const PEOPLE_PAGE = 25;
peopleRouter.get("/customers", async (req, res) => {
    const u = req.user;
    const g = await getGuild();
    const q = str(req.query.q);
    const page = Math.max(1, parseInt(str(req.query.page)) || 1);
    const where = { orders: { some: { guildId: g.id } }, ...(q ? { OR: [{ username: { contains: q, mode: "insensitive" } }, { discordId: { contains: q } }] } : {}) };
    const users = await prisma.user.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * PEOPLE_PAGE, take: PEOPLE_PAGE + 1, include: { _count: { select: { reviews: true } } } });
    const ids = users.map((x) => x.id);
    const [all, done] = await Promise.all([
        prisma.order.groupBy({ by: ["customerId"], where: { guildId: g.id, deletedAt: null, customerId: { in: ids } }, _count: { _all: true }, _sum: { paidSatang: true } }),
        prisma.order.groupBy({ by: ["customerId"], where: { guildId: g.id, deletedAt: null, status: "COMPLETED", customerId: { in: ids } }, _count: { _all: true } }),
    ]);
    res.send(layout({ title: "ลูกค้า", user: u, active: "/customers", msg: flash(req), body: `<h1>ลูกค้า</h1>
<form class="card row" method="get"><div><label for="q">ค้นหา (ชื่อ/Discord ID)</label><input id="q" name="q" value="${esc(q)}"></div><button type="submit">ค้นหา</button></form>
<div class="card wrap"><table><tr><th>Discord</th><th>Discord ID</th><th>ออเดอร์</th><th>เสร็จสิ้น</th><th>ยอดชำระที่บันทึก</th><th>รีวิว</th><th>สร้างเมื่อ</th></tr>
${users.slice(0, PEOPLE_PAGE).map((c) => `<tr><td>${esc(c.username)}</td><td>${esc(c.discordId)}</td><td>${all.find((x) => x.customerId === c.id)?._count._all ?? 0}</td><td>${done.find((x) => x.customerId === c.id)?._count._all ?? 0}</td>
<td>${formatBaht(all.find((x) => x.customerId === c.id)?._sum.paidSatang ?? 0)}</td><td>${c._count.reviews}</td><td>${thDate(c.createdAt)}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">ยังไม่มีลูกค้า</td></tr>`}</table></div>
${pager(`/customers?q=${encodeURIComponent(q)}`, page, users.length > PEOPLE_PAGE)}` }));
});
peopleRouter.get("/reviews", async (req, res) => {
    const u = req.user;
    const g = await getGuild();
    const rating = parseInt(str(req.query.rating)) || 0;
    const page = Math.max(1, parseInt(str(req.query.page)) || 1);
    const list = await prisma.review.findMany({
        where: { guildId: g.id, ...(rating >= 1 && rating <= 5 ? { rating } : {}) }, orderBy: { createdAt: "desc" },
        skip: (page - 1) * PEOPLE_PAGE, take: PEOPLE_PAGE + 1, include: { order: true, customer: true },
    });
    res.send(layout({ title: "รีวิว", user: u, active: "/reviews", msg: flash(req), body: `<h1>รีวิว</h1>
<form class="card row" method="get"><div><label for="r">กรองคะแนน</label><select id="r" name="rating"><option value="">ทั้งหมด</option>${[5, 4, 3, 2, 1].map((n) => `<option value="${n}" ${n === rating ? "selected" : ""}>${n} ดาว</option>`).join("")}</select></div><button type="submit">กรอง</button></form>
${list.slice(0, PEOPLE_PAGE).map((r) => `<div class="card"><b>${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</b> ${r.hidden ? badge("ซ่อนอยู่", "warn") : ""}
<span class="muted"> ${esc(r.customer.username)} · <a href="/orders/${esc(r.orderId)}">${esc(r.order.orderNo)}</a> · ${thDate(r.createdAt)}</span>
<p style="white-space:pre-wrap">${esc(r.comment ?? "(ไม่มีข้อความ)")}</p>${r.hidden ? `<p class="muted">เหตุผลที่ซ่อน: ${esc(r.hiddenReason ?? "")}</p>` : ""}
<form method="post" action="/reviews/${esc(r.id)}/${r.hidden ? "unhide" : "hide"}" class="row">${csrf(u)}
${r.hidden ? "" : `<div><label>เหตุผลที่ซ่อน</label><input name="reason" required maxlength="200"></div>`}
<button class="${r.hidden ? "ghost" : "danger"}" type="submit">${r.hidden ? "เลิกซ่อน" : "ซ่อนรีวิว"}</button></form></div>`).join("") || `<p class="muted">ยังไม่มีรีวิว</p>`}
${pager(`/reviews?rating=${rating || ""}`, page, list.length > PEOPLE_PAGE)}` }));
});
peopleRouter.post("/reviews/:id/:op", async (req, res) => {
    await act(res, "/reviews", "บันทึกแล้ว", async () => {
        const g = await getGuild();
        const hide = req.params.op === "hide";
        if (!hide && req.params.op !== "unhide")
            throw new AppError("BAD", "คำสั่งไม่ถูกต้อง");
        const reason = str(req.body.reason).slice(0, 200);
        if (hide && !reason)
            throw new AppError("BAD", "ต้องระบุเหตุผล");
        const r = await prisma.review.updateMany({
            where: { id: req.params.id, guildId: g.id },
            data: hide ? { hidden: true, hiddenReason: reason, hiddenByDiscordId: req.user.uid } : { hidden: false, hiddenReason: null, hiddenByDiscordId: null },
        });
        if (r.count !== 1)
            throw new AppError("NOT_FOUND", "ไม่พบรีวิว");
        await audit(prisma, g.id, req.user.uid, hide ? "review.hide" : "review.unhide", "Review", req.params.id, undefined, { reason });
    });
});
// ===== web/routes/admin.ts =====
const adminRouter = (0, express_1.Router)();
adminRouter.use(["/settings", "/audit"], requireLevel("ADMIN"));
adminRouter.use("/staff", requireLevel("OWNER"));
const snowflake = /^\d{15,25}$/;
const HOOKS = [
    ["orderWebhook", "แจ้งทีมงาน", "ออเดอร์ใหม่ / แจ้งชำระเงิน / ข้อความจากลูกค้า (ห้องที่ทีมงานเห็น)"],
    ["statusWebhook", "แจ้งลูกค้า", "อัปเดตสถานะ / ผลชำระเงิน / ข้อความจากทีมงาน (แท็กชื่อลูกค้าในห้อง)"],
    ["reviewWebhook", "รีวิว", "รีวิวใหม่จากลูกค้า"],
    ["logWebhook", "Log", "บันทึกการเปลี่ยนสถานะออเดอร์"],
];
adminRouter.get("/settings", async (req, res) => {
    const u = req.user;
    const { settings: s } = await getSettings();
    res.send(layout({ title: "ตั้งค่า", user: u, active: "/settings", msg: flash(req), body: `<h1>ตั้งค่าร้าน</h1>
<form method="post" action="/settings" class="card">${csrf(u)}
<h2>สถานะร้าน</h2><label><input type="checkbox" name="shopOpen" ${s.shopOpen ? "checked" : ""}> เปิดรับออเดอร์</label>
<h2 style="margin-top:14px">ช่องทางชำระเงิน (แสดงให้ลูกค้าเห็นในหน้าออเดอร์)</h2>
<textarea name="paymentInfo" maxlength="500" placeholder="เช่น PromptPay / เลขบัญชี ชื่อบัญชี">${esc(s.paymentInfo)}</textarea>
<h2 style="margin-top:14px">Discord Webhook</h2>
<p class="muted">ใน Discord: ตั้งค่าห้อง &gt; Integrations &gt; Webhooks &gt; New Webhook &gt; Copy Webhook URL แล้ววางด้านล่าง (URL เป็นความลับ ระบบจะไม่แสดงให้เห็นอีก)</p>
${HOOKS.map(([k, name, d]) => {
            const cur = s[k];
            return `<div style="margin:12px 0"><label for="${k}"><b>${esc(name)}</b> — ${esc(d)}</label>
<input id="${k}" name="${k}" autocomplete="off" placeholder="${cur ? "ตั้งไว้แล้ว (…" + esc(cur.slice(-6)) + ") เว้นว่างเพื่อไม่เปลี่ยน" : "วาง Webhook URL"}" style="width:100%">
${cur ? `<label><input type="checkbox" name="clear_${k}"> ลบ Webhook นี้</label>` : ""}</div>`;
        }).join("")}
<h2 style="margin-top:14px">หน้าตา</h2><div class="row"><div><label for="c">สี Embed (เช่น #8B0000)</label><input id="c" name="embedColor" value="#${s.embedColor.toString(16).padStart(6, "0")}"></div>
<div><label for="f">Footer</label><input id="f" name="footerText" maxlength="100" value="${esc(s.footerText)}"></div></div>
<p><button type="submit">บันทึกการตั้งค่า</button></p></form>
<div class="card"><h2>ทดสอบ Webhook</h2><div class="row">${HOOKS.map(([k, name]) => `<form method="post" action="/settings/test">${csrf(u)}<input type="hidden" name="key" value="${k}"><button class="ghost" type="submit" ${s[k] ? "" : "disabled"}>ทดสอบ: ${esc(name)}</button></form>`).join("")}</div></div>` }));
});
adminRouter.post("/settings", async (req, res) => {
    await act(res, "/settings", "บันทึกการตั้งค่าแล้ว", async () => {
        const { guild, settings } = await getSettings();
        const data = { shopOpen: req.body.shopOpen === "on", footerText: str(req.body.footerText).slice(0, 100) || null, paymentInfo: str(req.body.paymentInfo).slice(0, 500) || null };
        const changed = [];
        for (const [k] of HOOKS) {
            const v = str(req.body[k]);
            if (req.body["clear_" + k] === "on") {
                data[k] = null;
                changed.push(k + ":ลบ");
            }
            else if (v) {
                if (!isWebhookUrl(v))
                    throw new AppError("BAD", "Webhook URL ไม่ถูกต้อง (ต้องเป็นลิงก์ https://discord.com/api/webhooks/...)");
                data[k] = v;
                changed.push(k + ":ตั้งใหม่");
            }
        }
        const col = str(req.body.embedColor).replace(/^#/, "");
        if (!/^[0-9a-fA-F]{6}$/.test(col))
            throw new AppError("BAD", "สี Embed ไม่ถูกต้อง (ตัวอย่าง #8B0000)");
        data.embedColor = parseInt(col, 16);
        await prisma.guildSettings.update({ where: { guildId: guild.id }, data });
        // ไม่บันทึก URL ของ Webhook ลง Audit Log (เป็นความลับ)
        await audit(prisma, guild.id, req.user.uid, "settings.update", "GuildSettings", settings.id, { shopOpen: settings.shopOpen }, { shopOpen: data.shopOpen, webhooks: changed });
    });
});
adminRouter.post("/settings/test", async (req, res) => {
    const key = str(req.body.key);
    if (!HOOKS.some(([k]) => k === key))
        return void back(res, "/settings", "ไม่พบ Webhook นี้", false);
    const ok = await postHook(key, brandEmbed().setTitle("ทดสอบ Webhook").setDescription(`ข้อความทดสอบจาก Dashboard โดย ${req.user.name}`), key === "statusWebhook" ? { mentionId: req.user.uid } : undefined);
    back(res, "/settings", ok ? "ส่งข้อความทดสอบแล้ว ตรวจดูในห้อง Discord" : "ส่งไม่สำเร็จ ตรวจ Webhook URL ว่ายังใช้ได้", ok);
});
adminRouter.get("/staff", async (req, res) => {
    const u = req.user;
    const g = await getGuild();
    const list = await prisma.staffMember.findMany({ where: { guildId: g.id, deletedAt: null }, orderBy: { createdAt: "asc" } });
    res.send(layout({ title: "ทีมงาน", user: u, active: "/staff", msg: flash(req), body: `<h1>ทีมงาน</h1>
<form method="post" action="/staff" class="card row">${csrf(u)}<div><label for="d">Discord User ID</label><input id="d" name="discordId" inputmode="numeric" required></div>
<div><label for="r">ระดับสิทธิ์</label><select id="r" name="role"><option value="STAFF">ทีมงาน (STAFF)</option><option value="ADMIN">แอดมิน (ADMIN)</option></select></div><button type="submit">เพิ่ม/แก้ไขสิทธิ์</button></form>
<div class="card wrap"><table><tr><th>Discord ID</th><th>ระดับ</th><th></th></tr>${list.map((s) => `<tr><td>${esc(s.discordId)}</td><td>${badge(s.role)}</td>
<td>${s.discordId === config.OWNER_DISCORD_ID ? `<span class="muted">เจ้าของร้าน</span>` : `<form method="post" action="/staff/${esc(s.id)}/remove" onsubmit="return confirm('ถอดสิทธิ์คนนี้?')">${csrf(u)}<button class="danger" type="submit">ถอดสิทธิ์</button></form>`}</td></tr>`).join("")}</table></div>` }));
});
adminRouter.post("/staff", async (req, res) => {
    await act(res, "/staff", "บันทึกทีมงานแล้ว", async () => {
        const g = await getGuild();
        const id = str(req.body.discordId);
        const role = str(req.body.role);
        if (!snowflake.test(id))
            throw new AppError("BAD", "Discord ID ไม่ถูกต้อง");
        if (role !== "STAFF" && role !== "ADMIN")
            throw new AppError("BAD", "ระดับสิทธิ์ไม่ถูกต้อง");
        if (id === config.OWNER_DISCORD_ID)
            throw new AppError("BAD", "แก้สิทธิ์เจ้าของร้านไม่ได้");
        await prisma.staffMember.upsert({ where: { guildId_discordId: { guildId: g.id, discordId: id } }, update: { role, deletedAt: null }, create: { guildId: g.id, discordId: id, role } });
        await audit(prisma, g.id, req.user.uid, "staff.set", "StaffMember", id, undefined, { role });
    });
});
adminRouter.post("/staff/:id/remove", async (req, res) => {
    await act(res, "/staff", "ถอดสิทธิ์แล้ว", async () => {
        const g = await getGuild();
        const s = await prisma.staffMember.findFirst({ where: { id: req.params.id, guildId: g.id, deletedAt: null } });
        if (!s || s.discordId === config.OWNER_DISCORD_ID)
            throw new AppError("BAD", "ถอดสิทธิ์คนนี้ไม่ได้");
        await prisma.staffMember.update({ where: { id: s.id }, data: { deletedAt: new Date() } });
        await audit(prisma, g.id, req.user.uid, "staff.remove", "StaffMember", s.discordId);
    });
});
adminRouter.get("/audit", async (req, res) => {
    const g = await getGuild();
    const logs = await prisma.auditLog.findMany({ where: { guildId: g.id }, orderBy: { createdAt: "desc" }, take: 100 });
    const j = (v) => (v == null ? "" : esc(JSON.stringify(v)).slice(0, 200));
    res.send(layout({ title: "Audit Log", user: req.user, active: "/audit", body: `<h1>Audit Log (100 รายการล่าสุด)</h1><div class="card wrap"><table>
<tr><th>เวลา</th><th>ผู้ทำ (Discord ID)</th><th>การกระทำ</th><th>เป้าหมาย</th><th>ก่อน</th><th>หลัง</th></tr>
${logs.map((l) => `<tr><td>${thDate(l.createdAt)}</td><td>${esc(l.actorDiscordId)}</td><td>${esc(l.action)}</td><td>${esc(l.entity)} ${esc(l.entityId ?? "")}</td><td>${j(l.before)}</td><td>${j(l.after)}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">ยังไม่มีรายการ</td></tr>`}</table></div>` }));
});
// ===== web/site.ts =====
const siteRouter = (0, express_1.Router)();
const SITE_CSS = `
:root{--bg:#07070a;--bg2:#0f0f13;--card:#14141a;--line:#26262e;--red:#8b0000;--red2:#e11d48;--text:#f5f5f6;--muted:#9a9aa6;--ok:#22c55e;--warn:#f59e0b}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 system-ui,-apple-system,"Noto Sans Thai","Sarabun",sans-serif}
a{color:#fca5a5}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--red2);outline-offset:3px}
.bar{position:sticky;top:0;z-index:10;background:rgba(7,7,10,.88);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.bar>div{max-width:1120px;margin:0 auto;padding:10px 18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.logo{font-weight:900;letter-spacing:.12em;color:#fff;text-decoration:none;font-size:18px}.logo b{color:var(--red2)}
.links{display:flex;gap:4px;flex:1;flex-wrap:wrap}.links a{color:var(--muted);text-decoration:none;padding:6px 10px;border-radius:8px}.links a:hover{color:#fff;background:#17171d}
.right{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.right form{margin:0}
.btn,button{background:linear-gradient(180deg,#a30000,var(--red));color:#fff;border:1px solid #b91c1c;border-radius:10px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
.btn:hover,button:hover{filter:brightness(1.15)}.ghost{background:#17171d;border-color:var(--line);color:#e5e5ea}.big{padding:14px 26px;font-size:17px}
.wrap{max-width:1120px;margin:0 auto;padding:0 18px}section{padding:64px 0}
.hero{padding:96px 0 72px;text-align:center;background:radial-gradient(ellipse 80% 60% at 50% 0%,rgba(139,0,0,.5),transparent 70%),linear-gradient(180deg,#0b0b0f,var(--bg))}
.eyebrow{color:#fca5a5;letter-spacing:.2em;font-size:13px;text-transform:uppercase}
h1{font-size:clamp(32px,6vw,58px);line-height:1.15;margin:12px 0 16px;font-weight:900}h1 em{font-style:normal;color:var(--red2)}
h2{font-size:clamp(24px,4vw,34px);margin:0 0 8px}.lead{color:var(--muted);max-width:640px;margin:0 auto 26px;font-size:18px}
.sub{color:var(--muted);margin:0 0 28px}.cta{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:48px}
.stat{background:rgba(20,20,26,.7);border:1px solid var(--line);border-radius:14px;padding:16px}.stat b{display:block;font-size:28px}.stat span{color:var(--muted);font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}.card h3{margin:0 0 6px;font-size:19px}.card p{margin:0;color:var(--muted)}
.svc{border-left:3px solid var(--red)}.alt{background:var(--bg2);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.pkg{display:flex;flex-direction:column;gap:10px;position:relative;overflow:hidden}.pkg img{width:100%;height:140px;object-fit:cover;border-radius:10px}
.price{font-size:30px;font-weight:900}.price small{font-size:14px;color:var(--muted);font-weight:400}
.pkg ul{margin:0;padding:0;list-style:none;color:var(--muted)}.pkg li{padding-left:18px;position:relative}.pkg li:before{content:"";position:absolute;left:0;top:11px;width:8px;height:2px;background:var(--red2)}
.steps{counter-reset:s;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}.steps .card:before{counter-increment:s;content:counter(s);display:inline-grid;place-items:center;width:34px;height:34px;border-radius:50%;background:var(--red);font-weight:800;margin-bottom:10px}
.stars{color:#fbbf24;letter-spacing:2px}details{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;margin-bottom:10px}summary{cursor:pointer;font-weight:600}details p{color:var(--muted);margin:10px 0 0}
footer{padding:36px 0;border-top:1px solid var(--line);color:var(--muted);text-align:center;font-size:14px}
.page{max-width:860px;margin:0 auto;padding:28px 18px 60px}.msg{padding:12px 14px;border-radius:10px;margin:0 0 14px;border:1px solid}.msg.ok{border-color:var(--ok);color:#86efac}.msg.err{border-color:var(--red2);color:#fca5a5}
label{display:block;color:var(--muted);font-size:14px;margin:12px 0 4px}input,select,textarea{width:100%;background:#0c0c10;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:11px 12px;font:inherit}textarea{min-height:110px}
.badge{display:inline-block;padding:2px 10px;border-radius:99px;font-size:13px;border:1px solid var(--line);background:#1a1a20}.b-ok{border-color:var(--ok);color:#86efac}.b-warn{border-color:var(--warn);color:#fcd34d}.b-bad{border-color:var(--red2);color:#fca5a5}
.tl{list-style:none;margin:0;padding:0;border-left:2px solid var(--line)}.tl li{padding:0 0 14px 16px;position:relative}.tl li:before{content:"";position:absolute;left:-6px;top:7px;width:10px;height:10px;border-radius:50%;background:var(--red2)}
.muted{color:var(--muted)}.row{display:flex;gap:10px;flex-wrap:wrap;justify-content:space-between;align-items:center}.pre{white-space:pre-wrap}
.tbl{width:100%;border-collapse:collapse}.tbl td,.tbl th{padding:10px 8px;border-bottom:1px solid var(--line);text-align:left}.scroll{overflow-x:auto}
@media(max-width:640px){section{padding:44px 0}.hero{padding:64px 0 48px}.links{display:none}}`;
const FAQ = [
    ["สั่งงานยังไง", "เข้าสู่ระบบด้วย Discord เลือกแพ็กเกจ กรอกรายละเอียดงาน ระบบจะสร้างออเดอร์และแจ้งทีมงานทันที คุณติดตามสถานะได้ในเว็บ"],
    ["ชำระเงินยังไง", "ดูช่องทางชำระเงินในหน้าออเดอร์ของคุณ แล้วกด แจ้งชำระเงิน พร้อมแนบลิงก์หลักฐาน ทีมงานจะตรวจสอบและยืนยันยอดให้ ระบบไม่ถือว่าชำระแล้วจนกว่าทีมงานยืนยัน"],
    ["ใช้เวลานานแค่ไหน", "แต่ละแพ็กเกจแสดงระยะเวลาโดยประมาณไว้ในการ์ด ส่วนงานตามสั่งทีมงานจะประเมินให้หลังรับออเดอร์"],
    ["ติดตามงานได้ที่ไหน", "ที่หน้า บัญชีของฉัน ในเว็บนี้ และเมื่อสถานะเปลี่ยน ทีมงานจะแท็กคุณในห้องแจ้งสถานะของ Discord ร้าน"],
    ["ต้องการแก้ไขหรือยกเลิกงาน", "ส่งข้อความถึงทีมงานในหน้าออเดอร์ของคุณ การเปลี่ยนสถานะทุกครั้งมีบันทึกประวัติ และการยกเลิกต้องระบุเหตุผล"],
];
const SERVICES = [
    ["ออกแบบและตกแต่งเซิร์ฟเวอร์", "วางโครงและหน้าตาเซิร์ฟเวอร์ให้เป็นเอกลักษณ์ตามแบรนด์ของคุณ"],
    ["จัดหมวดหมู่และห้องแชต", "แบ่งหมวดหมู่ ห้องข้อความ และลำดับการแสดงผลให้ใช้งานง่าย"],
    ["ห้องเสียงและห้องส่วนตัว", "จัดห้องเสียง ห้องส่วนตัว และสิทธิ์การเข้าถึงอย่างเป็นระบบ"],
    ["Role และ Permission", "ตั้งค่ายศและสิทธิ์ให้รัดกุม ลดความเสี่ยงจากการตั้งค่าผิดพลาด"],
    ["Welcome และระบบสมาชิก", "ต้อนรับสมาชิกใหม่ พร้อมแนวทางการรับ Role ที่เหมาะกับชุมชน"],
    ["ตั้งค่าบอทในเซิร์ฟเวอร์", "ติดตั้งและตั้งค่าบอทที่จำเป็นให้พร้อมใช้งาน"],
    ["งานปรับแต่งตามสั่ง", "บอกความต้องการของคุณ ทีมงานประเมินและทำให้ตามงานจริง"],
];
const mask = (n) => n.slice(0, 2) + "•••";
const stars = (n) => "★".repeat(n) + "☆".repeat(5 - n);
const sbadge = (t, k = "") => `<span class="badge ${k ? "b-" + k : ""}">${esc(t)}</span>`;
const statusBadge = (s) => sbadge(ORDER_STATUS_TH[s], s === "COMPLETED" ? "ok" : s === "CANCELLED" ? "bad" : s === "PENDING" || s === "WAITING_CUSTOMER" ? "warn" : "");
const custPayBadge = (s) => sbadge(PAYMENT_STATUS_TH[s], s === "PAID" ? "ok" : s === "REJECTED" ? "bad" : s === "UNPAID" ? "warn" : "");
function page(req, o) {
    const s = req.session;
    const nav = o.landing
        ? `<a href="#services">บริการ</a><a href="#packages">แพ็กเกจ</a><a href="#steps">ขั้นตอน</a><a href="#reviews">รีวิว</a><a href="#faq">คำถามที่พบบ่อย</a>`
        : `<a href="/">หน้าแรก</a>`;
    const right = s
        ? `<a class="btn ghost" href="/me">บัญชีของฉัน</a>${req.user ? `<a class="btn ghost" href="/dashboard">จัดการร้าน</a>` : ""}
<form method="post" action="/logout"><input type="hidden" name="_csrf" value="${esc(s.csrf)}"><button class="ghost" type="submit">ออกจากระบบ</button></form>`
        : `<a class="btn" href="/login/start?next=${encodeURIComponent(req.originalUrl)}">เข้าสู่ระบบด้วย Discord</a>`;
    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="JUKKINGDOM รับออกแบบและตกแต่งเซิร์ฟเวอร์ Discord"><title>${esc(o.title)}</title><style>${SITE_CSS}</style></head><body>
<header class="bar"><div><a class="logo" href="/">JUK<b>KINGDOM</b></a><nav class="links" aria-label="เมนูหลัก">${nav}</nav><div class="right">${right}</div></div></header>
${o.msg ? `<div class="page" style="padding-bottom:0"><div class="msg ${o.msg.ok ? "ok" : "err"}" role="status">${esc(o.msg.text)}</div></div>` : ""}
${o.body}
<footer><div class="wrap">© JUKKINGDOM · ร้านรับออกแบบและตกแต่งเซิร์ฟเวอร์ Discord${config.DISCORD_INVITE_URL ? ` · <a href="${esc(config.DISCORD_INVITE_URL)}" rel="noopener noreferrer" target="_blank">เข้าร่วม Discord ของร้าน</a>` : ""}</div></footer></body></html>`;
}
const loginLink = (req, text, cls = "btn big") => `<a class="${cls}" href="/login/start?next=${encodeURIComponent(req.session ? "/order/new" : "/order/new")}">${text}</a>`;
async function sitePackages() {
    const g = await getGuild();
    return prisma.productPackage.findMany({
        where: { active: true, deletedAt: null, product: { guildId: g.id, active: true, deletedAt: null } },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], take: 24,
    });
}
// ---------- หน้าแรก ----------
siteRouter.get("/", async (req, res) => {
    const g = await getGuild();
    const { settings } = await getSettings();
    const [pkgs, sum, recent, done] = await Promise.all([
        sitePackages(), ratingSummary(),
        prisma.review.findMany({ where: { guildId: g.id, hidden: false }, orderBy: { createdAt: "desc" }, take: 6, include: { customer: true } }),
        prisma.order.count({ where: { guildId: g.id, deletedAt: null, status: "COMPLETED" } }),
    ]);
    const orderHref = req.session ? "/order/new" : `/login/start?next=${encodeURIComponent("/order/new")}`;
    res.send(page(req, { title: "JUKKINGDOM — รับออกแบบและตกแต่งเซิร์ฟเวอร์ Discord", landing: true, msg: flash(req), body: `
<div class="hero"><div class="wrap"><div class="eyebrow">Discord Server Design Studio</div>
<h1>เซิร์ฟเวอร์ Discord ของคุณ<br>ให้ดู<em>พรีเมียม</em> และใช้งานง่าย</h1>
<p class="lead">ออกแบบ ตกแต่ง จัดระบบห้องและสิทธิ์ ตั้งค่าบอท ครบในที่เดียว สั่งงาน ติดตามสถานะ แชตกับทีมงาน และรับแจ้งเตือนใน Discord ได้ตลอด</p>
<div class="cta">${settings.shopOpen ? `<a class="btn big" href="${orderHref}">สั่งงานเลย</a>` : `<span class="badge b-warn" style="padding:12px 20px">ขณะนี้ร้านปิดรับออเดอร์ชั่วคราว</span>`}<a class="btn ghost big" href="#packages">ดูแพ็กเกจ</a></div>
<div class="stats"><div class="stat"><b>${done}</b><span>งานที่ส่งมอบแล้ว</span></div>
<div class="stat"><b>${sum.count ? sum.avg.toFixed(1) + " / 5" : "-"}</b><span>คะแนนรีวิวเฉลี่ย (${sum.count} รีวิว)</span></div>
<div class="stat"><b>${pkgs.length}</b><span>แพ็กเกจที่เปิดขาย</span></div></div></div></div>
<section id="services"><div class="wrap"><h2>บริการของเรา</h2><p class="sub">ทุกงานทำตามความต้องการของคุณ</p>
<div class="grid">${SERVICES.map(([t, d]) => `<div class="card svc"><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join("")}</div></div></section>
<section id="packages" class="alt"><div class="wrap"><h2>แพ็กเกจและราคา</h2><p class="sub">เลือกแพ็กเกจที่เหมาะกับคุณ หรือสั่งงานตามสั่งได้</p>
${pkgs.length ? `<div class="grid">${pkgs.map((p) => `<div class="card pkg">${p.coverUrl ? `<img src="${esc(p.coverUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}
<h3>${esc(p.name)}</h3><div class="price">${p.isCustom ? "ตามตกลง" : esc(formatBaht(p.priceSatang))}${p.etaDays ? ` <small>· ประมาณ ${p.etaDays} วัน</small>` : ""}</div>
${p.description ? `<p>${esc(p.description)}</p>` : ""}${p.inclusions.length ? `<ul>${p.inclusions.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
${settings.shopOpen ? `<a class="btn" style="margin-top:auto;text-align:center" href="${req.session ? `/order/new?pkg=${esc(p.id)}` : `/login/start?next=${encodeURIComponent("/order/new?pkg=" + p.id)}`}">เลือกแพ็กเกจนี้</a>` : ""}</div>`).join("")}</div>`
            : `<div class="card"><p>ยังไม่มีแพ็กเกจที่เปิดขาย กลับมาใหม่เร็วๆ นี้</p></div>`}</div></section>
<section id="steps"><div class="wrap"><h2>ขั้นตอนการสั่งงาน</h2><p class="sub">ง่ายและติดตามได้ทุกขั้นตอน</p><div class="steps">
<div class="card"><h3>เลือกแพ็กเกจ</h3><p>เลือกแพ็กเกจที่ต้องการ หรือเลือกงานตามสั่ง</p></div>
<div class="card"><h3>เข้าสู่ระบบด้วย Discord</h3><p>ใช้บัญชี Discord ของคุณ ไม่ต้องสมัครใหม่</p></div>
<div class="card"><h3>กรอกรายละเอียดงาน</h3><p>บอกความต้องการ งบ ลิงก์ตัวอย่าง และวันส่งงาน</p></div>
<div class="card"><h3>ชำระเงินและติดตาม</h3><p>แจ้งชำระเงิน ทีมงานตรวจสอบ และอัปเดตสถานะให้คุณ</p></div>
<div class="card"><h3>รับงานและรีวิว</h3><p>เมื่องานเสร็จ ให้คะแนนและรีวิวได้</p></div></div></div></section>
<section id="reviews" class="alt"><div class="wrap"><h2>รีวิวจากลูกค้า</h2>
<p class="sub">${sum.count ? `<span class="stars">${stars(Math.round(sum.avg))}</span> ${sum.avg.toFixed(2)} จาก ${sum.count} รีวิว` : "ยังไม่มีรีวิว"}</p>
${recent.length ? `<div class="grid">${recent.map((r) => `<div class="card"><div class="stars">${stars(r.rating)}</div><p class="pre" style="margin:8px 0;color:var(--text)">${esc(r.comment ?? "")}</p><p>${esc(mask(r.customer.username))} · ${thDay(r.createdAt)}</p></div>`).join("")}</div>` : ""}</div></section>
<section id="faq"><div class="wrap" style="max-width:820px"><h2>คำถามที่พบบ่อย</h2><p class="sub"></p>
${FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</div></section>` }));
});
// ---------- สั่งงานผ่านเว็บ ----------
siteRouter.get("/order/new", requireLogin, async (req, res) => {
    const { settings } = await getSettings();
    const pkgs = await sitePackages();
    const sel = str(req.query.pkg);
    const s = req.session;
    if (!settings.shopOpen)
        return void res.send(page(req, { title: "สั่งงาน", body: `<div class="page"><div class="card"><h1 style="font-size:26px">ร้านปิดรับออเดอร์ชั่วคราว</h1><p class="muted">กรุณากลับมาใหม่ภายหลัง</p></div></div>` }));
    if (!pkgs.length)
        return void res.send(page(req, { title: "สั่งงาน", body: `<div class="page"><div class="card"><h1 style="font-size:26px">ยังไม่มีแพ็กเกจที่เปิดขาย</h1></div></div>` }));
    const min = new Date(Date.now() + 86400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
    res.send(page(req, { title: "สั่งงาน", msg: flash(req), body: `<div class="page"><h1 style="font-size:30px">สั่งงาน</h1>
<form class="card" method="post" action="/order/new"><input type="hidden" name="_csrf" value="${esc(s.csrf)}"><input type="hidden" name="token" value="${(0, node_crypto_1.randomBytes)(18).toString("base64url")}">
<label for="pkg">แพ็กเกจ</label><select id="pkg" name="packageId" required>${pkgs.map((p) => `<option value="${esc(p.id)}" ${p.id === sel ? "selected" : ""}>${esc(p.name)} — ${p.isCustom ? "ตามตกลง" : esc(formatBaht(p.priceSatang))}</option>`).join("")}</select>
<label for="d">รายละเอียดงาน (อย่างน้อย 10 ตัวอักษร)</label><textarea id="d" name="details" required minlength="10" maxlength="1000"></textarea>
<label for="b">งบประมาณ (บาท) ไม่บังคับ</label><input id="b" name="budget" inputmode="decimal" maxlength="10">
<label for="l">ลิงก์ภาพอ้างอิง https:// (บรรทัดละลิงก์ ไม่เกิน 5) ไม่บังคับ</label><textarea id="l" name="links" maxlength="600" style="min-height:70px"></textarea>
<label for="due">วันส่งงานที่ต้องการ ไม่บังคับ</label><input id="due" type="date" name="due" min="${min}">
<p style="margin-top:18px"><button type="submit" class="big">ยืนยันการสั่งงาน</button></p>
<p class="muted" style="font-size:14px">ราคาเป็นไปตามแพ็กเกจที่เลือก ทีมงานจะตรวจสอบและยืนยันออเดอร์ให้ภายหลัง</p></form></div>` }));
});
siteRouter.post("/order/new", requireLogin, async (req, res) => {
    const s = req.session;
    try {
        const token = str(req.body.token);
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(token))
            throw new AppError("BAD", "ฟอร์มหมดอายุ กรุณาโหลดหน้าใหม่");
        const { settings } = await getSettings();
        if (!settings.shopOpen)
            throw new AppError("CLOSED", "ขณะนี้ร้านปิดรับออเดอร์ชั่วคราว");
        const details = str(req.body.details);
        if (details.length < 10 || details.length > 1000)
            throw new AppError("BAD", "รายละเอียดงานต้องยาว 10-1000 ตัวอักษร");
        let budget = null;
        if (str(req.body.budget)) {
            budget = bahtToSatang(str(req.body.budget));
            if (budget === null)
                throw new AppError("BAD", "งบประมาณไม่ถูกต้อง");
        }
        const links = str(req.body.links).split(/\s+/).filter(Boolean);
        if (links.length > 5)
            throw new AppError("BAD", "ลิงก์อ้างอิงได้ไม่เกิน 5 ลิงก์");
        for (const l of links) {
            try {
                if (new URL(l).protocol !== "https:")
                    throw 0;
            }
            catch {
                throw new AppError("BAD", "ลิงก์ต้องขึ้นต้นด้วย https:// และถูกต้อง");
            }
        }
        let due = null;
        if (str(req.body.due)) {
            due = dateInput(str(req.body.due));
            if (!due || isNaN(due.getTime()) || due.getTime() < Date.now())
                throw new AppError("BAD", "วันส่งงานไม่ถูกต้องหรืออยู่ในอดีต");
        }
        // กันสแปม: รอตรวจสอบได้ไม่เกิน 5 ออเดอร์ต่อคน
        const open = await prisma.order.count({ where: { status: "PENDING", deletedAt: null, customer: { discordId: s.uid } } });
        if (open >= 5)
            throw new AppError("LIMIT", "คุณมีออเดอร์ที่รอตรวจสอบอยู่หลายรายการแล้ว กรุณารอทีมงาน");
        const { order, created } = await createOrder({
            customerDiscordId: s.uid, customerName: s.name, packageId: str(req.body.packageId), details,
            referenceLinks: links, budgetSatang: budget, dueDate: due, idempotencyKey: `web:${s.uid}:${token}`,
        });
        back(res, `/me/orders/${order.orderNo}`, created ? "สร้างออเดอร์สำเร็จ ทีมงานจะตรวจสอบเร็วๆ นี้" : "ออเดอร์นี้ถูกสร้างไว้แล้ว", true);
    }
    catch (e) {
        if (e instanceof AppError)
            return void back(res, "/order/new", e.message, false);
        logger.error({ err: e }, "web order failed");
        back(res, "/order/new", "ระบบขัดข้อง กรุณาลองใหม่", false);
    }
});
// ---------- บัญชีของฉัน (เห็นเฉพาะข้อมูลของตัวเอง) ----------
siteRouter.get("/me", requireLogin, async (req, res) => {
    const s = req.session;
    const orders = await prisma.order.findMany({
        where: { deletedAt: null, customer: { discordId: s.uid } }, orderBy: { createdAt: "desc" }, take: 50, include: { items: true },
    });
    res.send(page(req, { title: "บัญชีของฉัน", msg: flash(req), body: `<div class="page"><div class="row"><h1 style="font-size:30px;margin:0">ออเดอร์ของฉัน</h1><a class="btn" href="/order/new">สั่งงานใหม่</a></div>
<div class="card scroll" style="margin-top:16px">${orders.length ? `<table class="tbl"><tr><th>เลขออเดอร์</th><th>แพ็กเกจ</th><th>สถานะ</th><th>การชำระเงิน</th><th>ราคา</th><th>สร้างเมื่อ</th></tr>
${orders.map((o) => `<tr><td><a href="/me/orders/${esc(o.orderNo)}">${esc(o.orderNo)}</a></td><td>${esc(o.items[0]?.nameSnapshot ?? "-")}</td><td>${statusBadge(o.status)}</td><td>${custPayBadge(o.paymentStatus)}</td><td>${o.priceSatang ? esc(formatBaht(o.priceSatang)) : "รอประเมิน"}</td><td>${thDate(o.createdAt)}</td></tr>`).join("")}</table>`
            : `<p class="muted">คุณยังไม่มีออเดอร์ <a href="/order/new">สั่งงานเลย</a></p>`}</div></div>` }));
});
siteRouter.get("/me/orders/:orderNo", requireLogin, async (req, res) => {
    const s = req.session;
    const g = await getGuild();
    const { settings } = await getSettings();
    const o = await prisma.order.findFirst({
        where: { orderNo: req.params.orderNo.toUpperCase(), guildId: g.id, deletedAt: null, customer: { discordId: s.uid } }, // กัน IDOR
        include: { items: true, history: { orderBy: { createdAt: "desc" } }, payments: { orderBy: { createdAt: "desc" } }, review: true, messages: { orderBy: { createdAt: "asc" }, take: 200 } },
    });
    if (!o)
        return void res.status(404).send(page(req, { title: "ไม่พบออเดอร์", body: `<div class="page"><div class="card"><h1 style="font-size:26px">ไม่พบออเดอร์นี้</h1><p><a href="/me">กลับไปออเดอร์ของฉัน</a></p></div></div>` }));
    const remaining = o.priceSatang - o.paidSatang;
    const base = `/me/orders/${esc(o.orderNo)}`;
    const csrf = `<input type="hidden" name="_csrf" value="${esc(s.csrf)}">`;
    const canPay = o.status !== "CANCELLED" && o.priceSatang > 0 && remaining > 0;
    res.send(page(req, { title: o.orderNo, msg: flash(req), body: `<div class="page"><p><a href="/me">← ออเดอร์ของฉัน</a></p>
<h1 style="font-size:30px;margin:6px 0 14px">${esc(o.orderNo)} ${statusBadge(o.status)}</h1>
<div class="card"><div class="row"><div><span class="muted">แพ็กเกจ</span><br>${esc(o.items.map((i) => i.nameSnapshot).join(", "))}</div>
<div><span class="muted">ราคา</span><br>${o.priceSatang ? esc(formatBaht(o.priceSatang)) : "ทีมงานกำลังประเมิน"}</div>
<div><span class="muted">ชำระแล้ว</span><br>${esc(formatBaht(o.paidSatang))} ${custPayBadge(o.paymentStatus)}</div>
<div><span class="muted">กำหนดส่ง</span><br>${thDay(o.dueDate)}</div></div>
<h3 style="margin-top:18px">รายละเอียดที่คุณส่ง</h3><p class="pre muted">${esc(o.details)}</p>
${o.cancelReason ? `<p class="msg err">เหตุผลที่ยกเลิก: ${esc(o.cancelReason)}</p>` : ""}</div>
<div class="card"><h3>ความคืบหน้า</h3><ul class="tl">${o.history.map((h) => `<li><b>${esc(ORDER_STATUS_TH[h.toStatus])}</b> <span class="muted">· ${thDate(h.createdAt)}</span>${h.note ? `<br><span class="muted">${esc(h.note)}</span>` : ""}</li>`).join("")}</ul></div>
<div class="card"><h3>การชำระเงิน</h3>
${settings.paymentInfo ? `<p class="pre">${esc(settings.paymentInfo)}</p>` : `<p class="muted">ทีมงานจะแจ้งช่องทางชำระเงินให้</p>`}
${o.payments.length ? `<div class="scroll"><table class="tbl"><tr><th>เวลา</th><th>ยอดที่แจ้ง</th><th>สถานะ</th></tr>${o.payments.map((p) => `<tr><td>${thDate(p.createdAt)}</td><td>${esc(formatBaht(p.amountSatang))}</td><td>${p.status === "PENDING_VERIFICATION" ? sbadge("รอทีมงานตรวจสอบ", "warn") : p.status === "REJECTED" ? sbadge("ไม่ผ่านการตรวจสอบ", "bad") : sbadge("ยืนยันแล้ว", "ok")}</td></tr>`).join("")}</table></div>` : ""}
${canPay ? `<form method="post" action="${base}/payment"><h3 style="margin-top:16px">แจ้งชำระเงิน</h3>${csrf}
<label for="a">ยอดที่โอน (บาท) — คงเหลือ ${esc(formatBaht(remaining))}</label><input id="a" name="amount" inputmode="decimal" required>
<label for="u">ลิงก์หลักฐานการโอน (https://) เช่น ลิงก์รูปสลิป</label><input id="u" name="proofUrl" type="url" required maxlength="480" placeholder="https://">
<label for="n">หมายเหตุ ไม่บังคับ</label><input id="n" name="note" maxlength="200">
<p><button type="submit">ส่งหลักฐานให้ทีมงานตรวจสอบ</button></p><p class="muted" style="font-size:14px">ระบบจะยังไม่ถือว่าชำระแล้วจนกว่าทีมงานตรวจสอบและยืนยัน</p></form>`
            : o.priceSatang <= 0 ? `<p class="muted">รอทีมงานประเมินราคาก่อนจึงจะแจ้งชำระเงินได้</p>` : ""}</div>
<div class="card"><h3>ข้อความกับทีมงาน</h3>${o.messages.length ? o.messages.map((m) => `<p style="margin:8px 0"><b>${m.isStaff ? "ทีมงาน" : "คุณ"}</b> <span class="muted">· ${thDate(m.createdAt)}</span><br><span class="pre">${esc(m.content)}</span></p>`).join("") : `<p class="muted">ยังไม่มีข้อความ</p>`}
<form method="post" action="${base}/message">${csrf}<label for="m">ส่งข้อความถึงทีมงาน</label><textarea id="m" name="content" required maxlength="1000" style="min-height:80px"></textarea><p><button type="submit">ส่งข้อความ</button></p></form></div>
<div class="card"><h3>รีวิว</h3>${o.review ? `<div class="stars">${stars(o.review.rating)}</div><p class="pre">${esc(o.review.comment ?? "")}</p>`
            : o.status === "COMPLETED" ? `<form method="post" action="${base}/review">${csrf}<label for="r">คะแนน</label><select id="r" name="rating">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${n} ดาว</option>`).join("")}</select>
<label for="c">ข้อความรีวิว</label><textarea id="c" name="comment" maxlength="500"></textarea><p><button type="submit">ส่งรีวิว</button></p></form>`
                : `<p class="muted">รีวิวได้เมื่อออเดอร์เสร็จสิ้นแล้ว</p>`}</div></div>` }));
});
siteRouter.post("/me/orders/:orderNo/payment", requireLogin, async (req, res) => {
    const url = `/me/orders/${req.params.orderNo}`;
    try {
        const amount = bahtToSatang(str(req.body.amount));
        if (amount === null)
            throw new AppError("BAD", "ยอดเงินไม่ถูกต้อง");
        await submitPaymentProof({ orderNo: req.params.orderNo, customerDiscordId: req.session.uid, amountSatang: amount, proofUrl: str(req.body.proofUrl), note: str(req.body.note).slice(0, 200) });
        back(res, url, "ส่งหลักฐานแล้ว ทีมงานจะตรวจสอบเร็วๆ นี้", true);
    }
    catch (e) {
        if (e instanceof AppError)
            return void back(res, url, e.message, false);
        logger.error({ err: e }, "payment proof failed");
        back(res, url, "ระบบขัดข้อง กรุณาลองใหม่", false);
    }
});
siteRouter.post("/me/orders/:orderNo/review", requireLogin, async (req, res) => {
    const url = `/me/orders/${req.params.orderNo}`;
    try {
        await createReview({ orderNo: req.params.orderNo, customerDiscordId: req.session.uid, rating: parseInt(str(req.body.rating), 10), comment: str(req.body.comment).slice(0, 500) });
        back(res, url, "ขอบคุณสำหรับรีวิว", true);
    }
    catch (e) {
        if (e instanceof AppError)
            return void back(res, url, e.message, false);
        logger.error({ err: e }, "review failed");
        back(res, url, "ระบบขัดข้อง กรุณาลองใหม่", false);
    }
});
siteRouter.post("/me/orders/:orderNo/message", requireLogin, async (req, res) => {
    const url = `/me/orders/${req.params.orderNo}`;
    try {
        await addOrderMessage({ orderNo: req.params.orderNo, authorDiscordId: req.session.uid, authorName: req.session.name, content: str(req.body.content), staff: false });
        back(res, url, "ส่งข้อความถึงทีมงานแล้ว", true);
    }
    catch (e) {
        if (e instanceof AppError)
            return void back(res, url, e.message, false);
        logger.error({ err: e }, "message failed");
        back(res, url, "ระบบขัดข้อง กรุณาลองใหม่", false);
    }
});
// ===== web/server.ts =====
function createApp() {
    const app = (0, express_1.default)();
    app.set("trust proxy", 1); // ใช้หลัง Reverse Proxy ของโฮสต์ (Railway ฯลฯ)
    app.disable("x-powered-by");
    app.use((req, res, next) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Referrer-Policy", "same-origin");
        res.setHeader("Cache-Control", "no-store");
        next();
    });
    app.get("/health", async (_req, res) => {
        try {
            await prisma.$queryRaw `SELECT 1`;
            res.json({ ok: true });
        }
        catch {
            res.status(503).json({ ok: false });
        }
    });
    app.use(express_1.default.urlencoded({ extended: false, limit: "50kb" }));
    app.use(loadUser);
    app.use(csrfCheck);
    app.use(authRouter);
    app.use(overviewRouter, ordersRouter, packagesRouter, peopleRouter, adminRouter, siteRouter);
    app.use((req, res) => res.status(404).send(layout({ title: "ไม่พบหน้า", user: req.user, body: `<div class="card"><h1>ไม่พบหน้านี้</h1></div>` })));
    app.use((err, _req, res, _next) => {
        logger.error({ err }, "web error"); // ไม่แสดง Stack Trace ให้ผู้ใช้
        res.status(500).send("เกิดข้อผิดพลาดภายในระบบ");
    });
    return app;
}
const app = createApp();
exports.default = app;
module.exports = exports.default;
