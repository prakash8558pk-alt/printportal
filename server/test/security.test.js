import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.ALLOW_SIGNUP = 'true';
const { default: app } = await import('../src/app.js');
const { initDatabase, db } = await import('../src/config/turso.js');
const { initSocket } = await import('../src/config/socket.js');

test('Turso workflow enforces organization boundaries and file authorization', async () => {
  await initDatabase();
  const server = app.listen(0, '127.0.0.1');
  initSocket(server);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function call(path, token, body, method = 'POST') {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  try {
    const first = await call('/auth/signup-org', null, {orgName:'First',adminName:'Admin',email:'first@example.test',password:'strong-password-first'});
    assert.equal(first.status,201);
    const second = await call('/auth/signup-org', null, {orgName:'Second',adminName:'Admin',email:'second@example.test',password:'strong-password-second'});
    assert.equal(second.status,201);
    const added = await call('/users', first.data.token, {name:'Employee',email:'employee@example.test',password:'employee-password-secure',role:'EMPLOYEE'});
    assert.equal(added.status,201);
    assert.equal((await call(`/users/${added.data.data.id}`,second.data.token,null,'DELETE')).status,404);
    assert.equal((await call(`/users/${added.data.data.id}/terminate`,second.data.token,{},'PUT')).status,404);
    const login = await call('/auth/login',null,{email:'employee@example.test',password:'employee-password-secure',role:'EMPLOYEE'});
    assert.equal(login.status,200);
    const form = new FormData();
    for (const [key,value] of Object.entries({title:'Test file',copies:'1',printType:'SINGLE_SIDE',deliveryType:'PICKUP',dueDateTime:new Date().toISOString()})) form.set(key,value);
    form.set('file',new Blob(['test document'],{type:'text/plain'}),'test.txt');
    const uploaded = await fetch(base+'/print-requests',{method:'POST',headers:{Authorization:`Bearer ${login.data.token}`},body:form});
    assert.equal(uploaded.status,201);
    const request = (await uploaded.json()).request;
    assert.equal((await fetch(base+`/print-requests/${request._id}/file`)).status,401);
    assert.equal((await fetch(base+`/print-requests/${request._id}/file`,{headers:{Authorization:`Bearer ${second.data.token}`}})).status,404);
    const ownFile = await fetch(base+`/print-requests/${request._id}/file`,{headers:{Authorization:`Bearer ${login.data.token}`}});
    assert.equal(await ownFile.text(),'test document');
    assert.equal((await call(`/print-requests/${request._id}/approve`,first.data.token,{},'PUT')).status,200);
    const stats = await call('/dashboard/stats',first.data.token,null,'GET');
    assert.equal(stats.status,200);
    assert.equal(stats.data.data.approved,1);
    assert.equal((await call(`/users/${added.data.data.id}/terminate`,first.data.token,{},'PUT')).status,200);
    assert.equal((await call('/print-requests',login.data.token,null,'GET')).status,401);
    assert.equal((await call('/auth/refresh-token',null,{refreshToken:login.data.refreshToken})).status,401);
    process.env.ALLOW_SIGNUP='false';
    assert.equal((await call('/auth/signup-org',null,{orgName:'No',adminName:'No',email:'no@example.test',password:'strong-password-none'})).status,403);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});
