const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (cb) => {
  const h = (_e, data) => cb(data);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.off(channel, h);
};
const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('may', {
  listChats: call('chats:list'),
  getChat: call('chats:get'),
  openChat: call('chats:open'),
  createChat: call('chats:create'),
  deleteChat: call('chats:delete'),
  setProvider: call('chats:setProvider'),
  chooseCwd: call('chats:chooseCwd'),
  setCwd: call('chats:setCwd'),
  revokeAuto: call('chats:revokeAuto'),
  send: call('chat:send'),
  stop: call('chat:stop'),
  decide: call('tool:decide'),
  stopTool: call('tool:stop'),
  status: call('status:get'),
  settings: call('settings:get'),
  setSettings: call('settings:set'),
  chooseDefaultCwd: call('settings:chooseDefaultCwd'),
  setKey: call('settings:setKey'),
  clearKey: call('settings:clearKey'),
  skills: call('skills:list'),
  saveSkill: call('skills:save'),
  deleteSkill: call('skills:delete'),
  refreshBalance: call('balance:refresh'),
  onChatEvent: listen('chat:event'),
  onNotify: listen('notify'),
  onStatus: listen('status'),
});
