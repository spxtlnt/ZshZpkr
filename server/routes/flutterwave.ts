import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";

const flutterwaveBaseUrl = "https://api.flutterwave.com/v3";
const paymentMethods = ["card", "mobile-money"] as const;

const createOrderSchema = z.object({
  orderType: z.enum(["delivery", "take-away", "dine-in", "room-service"]),
  paymentMethod: z.enum(["card", "mobile-money", "room-charge", "cash"]),
  customer: z.object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    email: z.string().trim().email().max(254),
    phone: z.string().trim().min(7).max(32),
    roomNumber: z.string().trim().max(32).optional(),
    deliveryAddress: z.string().trim().max(500).optional(),
    specialRequests: z.string().trim().max(2000).optional(),
  }),
  items: z.array(z.object({ id: z.string().uuid(), quantity: z.number().int().min(1).max(100) })).min(1).max(50),
  tipAmount: z.number().min(0).max(1000000).default(0),
});

const getConfiguration = () => {
  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
  const webhookSecretHash = process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const redirectUrl = process.env.FLUTTERWAVE_REDIRECT_URL;

  if (!secretKey || !supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey || !redirectUrl) {
    throw new Error("Flutterwave payment configuration is incomplete");
  }

  return { secretKey, webhookSecretHash, supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey, redirectUrl };
};

const getUserId = async (authorization?: string) => {
  if (!authorization?.startsWith("Bearer ")) throw new Error("Please sign in before placing an order");

  const { supabaseUrl, supabaseAnonKey } = getConfiguration();
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: supabaseAnonKey, authorization },
  });
  if (!response.ok) throw new Error("Your session has expired. Please sign in again");

  const user = await response.json() as { id: string };
  return user.id;
};

const serviceRequest = async (path: string, init: RequestInit = {}) => {
  const { supabaseUrl, supabaseServiceRoleKey } = getConfiguration();
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: supabaseServiceRoleKey,
      authorization: `Bearer ${supabaseServiceRoleKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error("Unable to save payment information");
  return response;
};

const createOrderNumber = () => `MN${Date.now().toString(36).toUpperCase()}${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
const referencePrefix = "flwref:";
const transactionPrefix = "|flwid:";
const getReference = (transactionId: string | null | undefined) => transactionId?.match(/flwref:([^|]+)/)?.[1] ?? null;
const paymentRecord = (reference: string, transactionId?: string | number) =>
  `${referencePrefix}${reference}${transactionId ? `${transactionPrefix}${transactionId}` : ""}`;

const getOrderById = async (orderId: string) => {
  const response = await serviceRequest(`menu_orders?id=eq.${encodeURIComponent(orderId)}&select=*`);
  const [order] = await response.json();
  if (!order) throw new Error("Order not found");
  return order as Record<string, any>;
};

const updateOrder = async (orderId: string, values: Record<string, unknown>) => {
  await serviceRequest(`menu_orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify(values),
  });
};

const verifyTransaction = async (transactionId: string) => {
  const { secretKey } = getConfiguration();
  const response = await fetch(`${flutterwaveBaseUrl}/transactions/${encodeURIComponent(transactionId)}/verify`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const payload = await response.json();
  if (!response.ok || payload.status !== "success" || !payload.data) throw new Error("Payment verification failed");
  return payload.data as Record<string, any>;
};

const reconcilePayment = async (transactionId: string, expectedReference?: string) => {
  const transaction = await verifyTransaction(transactionId);
  const reference = transaction.tx_ref as string | undefined;
  if (!reference || (expectedReference && reference !== expectedReference)) throw new Error("Payment reference does not match");

  const response = await serviceRequest(`menu_orders?transaction_id=like.${encodeURIComponent(`*${reference}*`)}&select=*`);
  const [order] = await response.json() as Array<Record<string, any>>;
  if (!order) throw new Error("Order not found");

  if (Number(transaction.amount) !== Number(order.total_amount) || transaction.currency !== "UGX") {
    throw new Error("Payment amount or currency does not match the order");
  }

  const succeeded = transaction.status === "successful";
  const terminalStatus = transaction.status === "cancelled" ? "cancelled" : transaction.status === "failed" ? "failed" : "pending";
  if (order.payment_status !== "paid" || succeeded) {
    await updateOrder(order.id, {
      transaction_id: paymentRecord(reference, transaction.id),
      payment_status: succeeded ? "paid" : terminalStatus,
      status: succeeded ? "confirmed" : "pending",
    });
  }
  return { order, paymentStatus: succeeded ? "paid" : terminalStatus };
};

export const createMenuOrder: RequestHandler = async (req, res) => {
  try {
    const input = createOrderSchema.parse(req.body);
    const userId = await getUserId(req.headers.authorization);
    if (input.orderType === "room-service" && !input.customer.roomNumber) throw new Error("A room number is required for room service");
    if (input.orderType === "delivery" && !input.customer.deliveryAddress) throw new Error("A delivery address is required");

    const requestedIds = [...new Set(input.items.map((item) => item.id))];
    const itemsResponse = await serviceRequest(`menu_items?id=in.(${requestedIds.join(",")})&is_published=eq.true&select=id,name,price,currency,availability`);
    const menuItems = await itemsResponse.json() as Array<{ id: string; name: string; price: number; currency: string; availability: number }>;
    const itemsById = new Map(menuItems.map((item) => [item.id, item]));
    if (itemsById.size !== requestedIds.length || menuItems.some((item) => item.currency !== "UGX")) {
      throw new Error("One or more items are unavailable for UGX checkout");
    }

    const lineItems = input.items.map((item) => {
      const menuItem = itemsById.get(item.id)!;
      if (menuItem.availability < item.quantity) throw new Error(`${menuItem.name} is no longer available in that quantity`);
      return { ...menuItem, quantity: item.quantity, lineTotal: Number(menuItem.price) * item.quantity };
    });
    const subtotal = lineItems.reduce((total, item) => total + item.lineTotal, 0);
    const taxAmount = subtotal * 0.08;
    const serviceFee = input.orderType === "room-service" ? 5 : input.orderType === "delivery" ? 8 : 0;
    const totalAmount = subtotal + taxAmount + serviceFee + input.tipAmount;
    const orderNumber = createOrderNumber();

    const orderResponse = await serviceRequest("menu_orders?select=id,order_number", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        order_number: orderNumber, user_id: userId, order_type: input.orderType, status: "pending",
        payment_method: input.paymentMethod, payment_status: input.paymentMethod === "cash" || input.paymentMethod === "room-charge" ? "pending" : "pending",
        first_name: input.customer.firstName, last_name: input.customer.lastName, email: input.customer.email, phone: input.customer.phone,
        room_number: input.customer.roomNumber || null, delivery_address: input.customer.deliveryAddress || null,
        special_requests: input.customer.specialRequests || null, subtotal, tax_amount: taxAmount, service_fee: serviceFee,
        tip_amount: input.tipAmount, points_discount: 0, total_amount: totalAmount,
      }),
    });
    const [order] = await orderResponse.json() as Array<{ id: string; order_number: string }>;

    try {
      await serviceRequest("menu_order_items", {
        method: "POST",
        body: JSON.stringify(lineItems.map((item) => ({ order_id: order.id, menu_item_id: item.id, item_name: item.name, unit_price: item.price, quantity: item.quantity, line_total: item.lineTotal }))),
      });
    } catch (error) {
      await serviceRequest(`menu_orders?id=eq.${encodeURIComponent(order.id)}`, { method: "DELETE" });
      throw error;
    }

    return res.status(201).json({ orderId: order.id, orderNumber: order.order_number, totalAmount, requiresOnlinePayment: paymentMethods.includes(input.paymentMethod as typeof paymentMethods[number]) });
  } catch (error) {
    const message = error instanceof z.ZodError ? "Please check the checkout details" : error instanceof Error ? error.message : "Unable to create order";
    return res.status(400).json({ error: message });
  }
};

export const initiateFlutterwavePayment: RequestHandler = async (req, res) => {
  try {
    const orderId = z.string().uuid().parse(req.body?.orderId);
    const userId = await getUserId(req.headers.authorization);
    const order = await getOrderById(orderId);
    if (order.user_id !== userId) return res.status(403).json({ error: "You cannot pay for this order" });
    if (!paymentMethods.includes(order.payment_method)) return res.status(400).json({ error: "This order does not require online payment" });
    if (order.payment_status === "paid") return res.status(409).json({ error: "This order has already been paid" });

    const reference = getReference(order.transaction_id) ?? `menu-${order.order_number}-${crypto.randomUUID()}`;
    const { secretKey, redirectUrl } = getConfiguration();
    const response = await fetch(`${flutterwaveBaseUrl}/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        tx_ref: reference, amount: String(order.total_amount), currency: "UGX", redirect_url: redirectUrl,
        payment_options: order.payment_method === "mobile-money" ? "mobilemoneyuganda" : "card",
        customer: { email: order.email, name: `${order.first_name} ${order.last_name}`.trim(), phonenumber: order.phone },
        meta: { order_id: order.id }, customizations: { title: "Sheraton Special" },
      }),
    });
    const payload = await response.json();
    if (!response.ok || payload.status !== "success" || !payload.data?.link) return res.status(502).json({ error: "Unable to start payment" });

    await updateOrder(order.id, { transaction_id: paymentRecord(reference), payment_status: "pending", status: "pending" });
    return res.json({ paymentLink: payload.data.link });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "Unable to start payment" });
  }
};

export const verifyFlutterwavePayment: RequestHandler = async (req, res) => {
  try {
    const transactionId = z.string().min(1).parse(req.query.transaction_id);
    const reference = z.string().min(1).parse(req.query.tx_ref);
    const { order, paymentStatus } = await reconcilePayment(transactionId, reference);
    return res.redirect(`/menu?order=${encodeURIComponent(order.id)}&payment=${encodeURIComponent(paymentStatus)}`);
  } catch (error) {
    console.error("Flutterwave payment verification error", error);
    return res.redirect("/menu?payment=verification_failed");
  }
};

const hasValidWebhookSignature = (req: Request) => {
  const { webhookSecretHash } = getConfiguration();
  const signature = req.header("verif-hash");
  if (!webhookSecretHash || !signature) return false;
  return signature.length === webhookSecretHash.length && timingSafeEqual(Buffer.from(signature), Buffer.from(webhookSecretHash));
};

export const handleFlutterwaveWebhook = async (req: Request, res: Response) => {
  try {
    if (!hasValidWebhookSignature(req)) return res.sendStatus(401);
    const payload = req.body as { event?: string; data?: { id?: string | number; tx_ref?: string } };
    if (payload.event !== "charge.completed" || !payload.data?.id || !payload.data.tx_ref) return res.sendStatus(200);
    await reconcilePayment(String(payload.data.id), payload.data.tx_ref);
    return res.sendStatus(200);
  } catch (error) {
    console.error("Flutterwave webhook error", error);
    return res.sendStatus(500);
  }
};
