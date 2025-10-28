const express = require('express');
const cors = require('cors');
const { pool, createUsersTable } = require('./db');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 5000;

// Ensure fetch is available (Node < 18 compatibility)
const fetch = (global && global.fetch)
  ? global.fetch
  : ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

// Middleware
app.use(cors());
app.use(express.json());

// Initialize database
createUsersTable();

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'IliganMart API is running' });
});

// Admin: list users
app.get('/api/admin/users', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, gender, role, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ success: true, users: result.rows });
  } catch (error) {
    console.error('Admin list users error:', error);
    res.status(500).json({ error: 'Failed to list users', details: error.message });
  }
});

// Get orders for seller by email
app.get('/api/seller/orders', async (req, res) => {
  try {
    const email = (req.query.email || '').toString().trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const userRes = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const userId = userRes.rows[0].id;

    const list = await pool.query(
      `SELECT o.id,
              o.product_id,
              p.name AS product_name,
              o.buyer_email,
              o.quantity,
              o.total_price,
              o.created_at
       FROM orders o
       JOIN products p ON p.id = o.product_id
       WHERE p.user_id = $1
       ORDER BY o.created_at DESC`,
      [userId]
    );

    res.json({ success: true, orders: list.rows });
  } catch (error) {
    console.error('Get seller orders error:', error);
    res.status(500).json({ error: 'Get seller orders failed', details: error.message });
  }
});

// Also expose PayPal endpoints under /api namespace for mobile clients using API_BASE_URL
app.post('/api/paypal/create-order', async (req, res) => {
  // Delegate to the same handler logic
  req.url = '/create-order';
  return app._router.handle(req, res, () => {});
});

app.post('/api/paypal/capture-order', async (req, res) => {
  req.url = '/capture-order';
  return app._router.handle(req, res, () => {});
});

// --- PayPal Integration (Sandbox) ---
const PAYPAL_BASE = process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';

async function getPayPalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const resp = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`PayPal token failed: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  return data.access_token;
}

// Create PayPal order
app.post('/create-order', async (req, res) => {
  try {
    const { amount } = req.body || {};
    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
      return res.status(500).json({ error: 'PayPal credentials not configured' });
    }

    const token = await getPayPalAccessToken();
    const orderResp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            amount: {
              currency_code: 'PHP',
              value: amt.toFixed(2),
            },
          },
        ],
        application_context: {
          return_url: 'https://example.com/success',
          cancel_url: 'https://example.com/cancel',
        },
      }),
    });
    const data = await orderResp.json();
    if (!orderResp.ok) {
      return res.status(orderResp.status).json(data);
    }
    return res.json(data);
  } catch (error) {
    console.error('PayPal create-order error:', error);
    return res.status(500).json({ error: 'Create order failed', details: String(error) });
  }
});

// Capture PayPal order
app.post('/capture-order', async (req, res) => {
  try {
    const { orderID } = req.body || {};
    if (!orderID) return res.status(400).json({ error: 'orderID is required' });

    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
      return res.status(500).json({ error: 'PayPal credentials not configured' });
    }

    const token = await getPayPalAccessToken();
    const capResp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderID}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });
    const data = await capResp.json();
    if (!capResp.ok) {
      return res.status(capResp.status).json(data);
    }
    return res.json(data);
  } catch (error) {
    console.error('PayPal capture-order error:', error);
    return res.status(500).json({ error: 'Capture order failed', details: String(error) });
  }
});

// Public products (for customers)
app.get('/api/products/public', async (req, res) => {
  try {
    const list = await pool.query(
      `SELECT p.id, p.name, p.description, p.price, p.category, p.stock, p.image_url, p.created_at,
              u.name AS seller_name
       FROM products p
       JOIN users u ON u.id = p.user_id
       WHERE p.stock > 0
       ORDER BY p.created_at DESC`
    );
    res.json({ success: true, products: list.rows });
  } catch (error) {
    console.error('Public products error:', error);
    res.status(500).json({ error: 'Public products failed', details: error.message });
  }
});

// Purchase product: creates order and decrements stock atomically
app.post('/api/purchase', async (req, res) => {
  const client = await pool.connect();
  try {
    const { productId, buyerEmail, quantity } = req.body;
    const qty = Number(quantity || 1);
    const email = (buyerEmail || '').trim().toLowerCase();
    if (!productId || !email || !qty || qty <= 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    await client.query('BEGIN');
    const prodRes = await client.query('SELECT id, price, stock FROM products WHERE id = $1 FOR UPDATE', [productId]);
    if (prodRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found' });
    }
    const prod = prodRes.rows[0];
    if (prod.stock < qty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient stock' });
    }

    const newStock = prod.stock - qty;
    await client.query('UPDATE products SET stock = $1, updated_at = NOW() WHERE id = $2', [newStock, productId]);
    const total = Number(prod.price) * qty;
    const orderRes = await client.query(
      `INSERT INTO orders (product_id, buyer_email, quantity, total_price)
       VALUES ($1, $2, $3, $4)
       RETURNING id, product_id, buyer_email, quantity, total_price, created_at`,
      [productId, email, qty, total]
    );
    await client.query('COMMIT');
    res.status(201).json({ success: true, order: orderRes.rows[0], remainingStock: newStock });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Purchase error:', error);
    res.status(500).json({ error: 'Purchase failed', details: error.message });
  } finally {
    client.release();
  }
});

// Get products for seller by email
app.get('/api/seller/products', async (req, res) => {
  try {
    const email = (req.query.email || '').toString().trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const userRes = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const userId = userRes.rows[0].id;

    const list = await pool.query(
      `SELECT id, user_id, name, description, price, category, stock, image_url, created_at
       FROM products WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    res.json({ success: true, products: list.rows });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Get products failed', details: error.message });
  }
});

// Create product for seller
app.post('/api/seller/products', async (req, res) => {
  try {
    const { email, name, description, price, category, stock, imageUrl } = req.body;
    const normEmail = (email || '').trim().toLowerCase();

    if (!normEmail || !name || !description || price == null || !category) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const userRes = await pool.query('SELECT id FROM users WHERE email = $1 AND role IN (\'seller\', \'customer\')', [normEmail]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userId = userRes.rows[0].id;

    const insert = await pool.query(
      `INSERT INTO products (user_id, name, description, price, category, stock, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, name, description, price, category, stock, image_url, created_at`,
      [userId, name, description, Number(price), category, Number(stock || 0), imageUrl || null]
    );

    res.status(201).json({ success: true, product: insert.rows[0] });
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: 'Create product failed', details: error.message });
  }
});

// Register Seller (single-step): creates user with role 'seller' and seller shop record
app.post('/api/register-seller', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      name,
      email,
      password,
      gender,
      shopName,
      shopDescription,
      shopAddress,
      shopPhone,
      shopEmail,
      businessType,
      businessPermit,
    } = req.body;

    const normUserEmail = (email || '').trim().toLowerCase();
    const normShopEmail = (shopEmail || '').trim().toLowerCase();

    if (!name || !normUserEmail || !password || !shopName || !shopAddress || !shopPhone || !normShopEmail || !businessType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    await client.query('BEGIN');

    const exists = await client.query('SELECT id FROM users WHERE email = $1', [normUserEmail]);
    if (exists.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const userInsert = await client.query(
      `INSERT INTO users (name, full_name, email, password, gender, role, created_at)
       VALUES ($1, $1, $2, $3, $4, 'seller', NOW())
       RETURNING id, name, email, gender, role, created_at`,
      [name, normUserEmail, hashedPassword, gender || null]
    );

    const user = userInsert.rows[0];

    const shopInsert = await client.query(
      `INSERT INTO sellers (user_id, shop_name, shop_description, shop_address, shop_phone, shop_email, business_type, business_permit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, shop_name, shop_email, business_type, created_at`,
      [user.id, shopName, shopDescription || '', shopAddress, shopPhone, normShopEmail, businessType, businessPermit || null]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Seller registered successfully',
      user,
      shop: shopInsert.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Register seller error:', error);
    res.status(500).json({ error: 'Register seller failed', details: error.message });
  } finally {
    client.release();
  }
});

// Register endpoint
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password, gender, role } = req.body;
    const normEmail = (email || '').trim().toLowerCase();

    // Validation
    if (!name || !normEmail || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [normEmail]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Hash password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Insert user (including full_name to match DB schema)
    const result = await pool.query(
      `INSERT INTO users (name, full_name, email, password, gender, role, created_at) 
       VALUES ($1, $1, $2, $3, $4, $5, NOW()) 
       RETURNING id, name, email, gender, role, created_at`,
      [name, normEmail, hashedPassword, gender || null, role || 'customer']
    );

    const user = result.rows[0];

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        gender: user.gender,
        role: user.role,
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed', details: error.message });
  }
});

// Login endpoint
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const normEmail = (email || '').trim().toLowerCase();

    // Validation
    if (!normEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find user
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [normEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Return user data (without password)
    res.json({
      success: true,
      message: 'Login successful',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        gender: user.gender,
        role: user.role,
        createdAt: user.created_at,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed', details: error.message });
  }
});

// Get user by email
app.get('/api/user/:email', async (req, res) => {
  try {
    const { email } = req.params;

    const result = await pool.query(
      'SELECT id, name, email, gender, role, created_at FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user', details: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 IliganMart API running on port ${PORT}`);
  console.log(`📡 Database: ${process.env.DB_HOST || process.env.PGHOST || 'Not configured'}`);
});
