'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');

const rideHailing = require('../server');
const { sendEmailViaResend } = rideHailing;

test('Resend sender posts email payload over HTTPS without SMTP', async () => {
  const previousApiKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.EMAIL_FROM;
  const originalRequest = https.request;
  let capturedOptions;
  let capturedBody = '';

  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'My Ride <no-reply@example.test>';

  https.request = (options, callback) => {
    capturedOptions = options;
    const request = new EventEmitter();
    request.write = chunk => { capturedBody += chunk; };
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      callback(response);
      process.nextTick(() => {
        response.emit('data', JSON.stringify({ id: 'email_test' }));
        response.emit('end');
      });
    };
    request.destroy = error => process.nextTick(() => request.emit('error', error));
    return request;
  };

  try {
    const result = await sendEmailViaResend({
      from: process.env.EMAIL_FROM,
      to: 'recipient@example.test',
      subject: 'My Ride test',
      text: 'Test message',
      html: '<p>Test message</p>'
    });

    assert.deepEqual(result, { id: 'email_test' });
    assert.equal(capturedOptions.hostname, 'api.resend.com');
    assert.equal(capturedOptions.path, '/emails');
    assert.equal(capturedOptions.method, 'POST');
    assert.equal(capturedOptions.headers.Authorization, 'Bearer re_test_key');
    assert.deepEqual(JSON.parse(capturedBody), {
      from: 'My Ride <no-reply@example.test>',
      to: 'recipient@example.test',
      subject: 'My Ride test',
      text: 'Test message',
      html: '<p>Test message</p>'
    });
  } finally {
    https.request = originalRequest;
    if (previousApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousApiKey;
    if (previousFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousFrom;
  }
});

test('email OTP configuration requires Resend API key and sender only', () => {
  const previousApiKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.EMAIL_FROM;
  const previousSmtpUser = process.env.SMTP_USER;
  const previousSmtpPass = process.env.SMTP_PASS;

  try {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_FROM = 'no-reply@example.test';
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    assert.equal(rideHailing.emailOtpConfigured(), true);

    delete process.env.RESEND_API_KEY;
    assert.equal(rideHailing.emailOtpConfigured(), false);
  } finally {
    if (previousApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousApiKey;
    if (previousFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousFrom;
    if (previousSmtpUser === undefined) delete process.env.SMTP_USER;
    else process.env.SMTP_USER = previousSmtpUser;
    if (previousSmtpPass === undefined) delete process.env.SMTP_PASS;
    else process.env.SMTP_PASS = previousSmtpPass;
  }
});