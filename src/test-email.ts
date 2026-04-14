// src/test-smtp-connection.ts
import 'dotenv/config';
import nodemailer from 'nodemailer';
import logger from './config/logger.js';

async function testSmtpConnection() {
  const config = {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false, // STARTTLS
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  };

  console.log('🔍 Testing SMTP config:', {
    host: config.host,
    port: config.port,
    user: config.auth?.user,
    pass: config.auth?.pass ? '***' : undefined,
  });

  if (!config.host || !config.auth?.user || !config.auth?.pass) {
    console.error('❌ Missing SMTP config values');
    return;
  }

  try {
    const transporter = nodemailer.createTransport(config);
    
    // Verify connection
    await transporter.verify();
    console.log('✅ SMTP server connection verified');
    
    // Try sending
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || config.auth.user,
      to: 'pardeep.attri327@gmail.com',
      subject: '✅ VoltStartEV SMTP Direct Test',
      text: `Test sent at ${new Date().toISOString()}\n\nIf you see this, SMTP is fully working!`,
    });
    
    console.log('✅ Email sent:', info.messageId);
  } catch (err: any) {
    console.error('❌ SMTP error:', err.message);
    if (err.responseCode) console.error('Response code:', err.responseCode);
    if (err.response) console.error('Response:', err.response);
  }
}

testSmtpConnection();
