// app.js – Full M-Pesa backend with order storage
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// In-memory order storage (use a real DB in production)
const orders = new Map();

const BUSINESS_SHORTCODE = process.env.BUSINESS_SHORTCODE;
const PASSKEY = process.env.MPESA_PASSKEY;
const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const ENVIRONMENT = process.env.ENVIRONMENT || 'sandbox';
const CALLBACK_URL = process.env.CALLBACK_URL;

console.log('🚀 M-Pesa Backend Starting...');
console.log(`💰 Business Number: ${BUSINESS_SHORTCODE}`);
console.log(`🌍 Environment: ${ENVIRONMENT}`);

// Get OAuth token
async function getAccessToken() {
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const url = ENVIRONMENT === 'sandbox'
    ? 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
    : 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';

  const response = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}` }
  });
  return response.data.access_token;
}

// STK Push endpoint
app.post('/api/mpesa/stkpush', async (req, res) => {
  const { phoneNumber, amount, accountReference, transactionDesc } = req.body;

  let formattedPhone = phoneNumber.toString().replace(/\s/g, '');
  if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.slice(1);
  else if (formattedPhone.startsWith('7')) formattedPhone = '254' + formattedPhone;

  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(`${BUSINESS_SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');

  try {
    const token = await getAccessToken();
    const url = ENVIRONMENT === 'sandbox'
      ? 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
      : 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

    const response = await axios.post(url, {
      BusinessShortCode: BUSINESS_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: formattedPhone,
      PartyB: BUSINESS_SHORTCODE,
      PhoneNumber: formattedPhone,
      CallBackURL: CALLBACK_URL,
      AccountReference: accountReference || 'GoldenDreamers',
      TransactionDesc: transactionDesc || 'Order Payment'
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const { CheckoutRequestID, ResponseCode } = response.data;
    if (ResponseCode === '0') {
      // Store order with pending status
      orders.set(CheckoutRequestID, {
        status: 'pending',
        amount,
        phoneNumber: formattedPhone,
        createdAt: new Date().toISOString()
      });
      res.json({ success: true, checkoutRequestId: CheckoutRequestID });
    } else {
      res.json({ success: false, error: response.data });
    }
  } catch (error) {
    console.error('STK Push error:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// M-Pesa callback endpoint
app.post('/api/mpesa/callback', (req, res) => {
  console.log('📞 Callback received:', JSON.stringify(req.body, null, 2));

  const { Body } = req.body;
  if (Body && Body.stkCallback) {
    const { CheckoutRequestID, ResultCode, ResultDesc, Amount, MpesaReceiptNumber } = Body.stkCallback;
    const status = ResultCode === 0 ? 'completed' : 'failed';
    if (orders.has(CheckoutRequestID)) {
      const order = orders.get(CheckoutRequestID);
      order.status = status;
      order.resultDesc = ResultDesc;
      order.receiptNumber = MpesaReceiptNumber;
      order.amountPaid = Amount;
      orders.set(CheckoutRequestID, order);
      console.log(`✅ Order ${CheckoutRequestID} updated: ${status}`);
    }
  }

  res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// Check order status
app.get('/api/order/status/:checkoutRequestId', (req, res) => {
  const { checkoutRequestId } = req.params;
  const order = orders.get(checkoutRequestId);
  if (order) {
    res.json({ exists: true, status: order.status, details: order });
  } else {
    res.json({ exists: false });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', business: BUSINESS_SHORTCODE, environment: ENVIRONMENT });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});