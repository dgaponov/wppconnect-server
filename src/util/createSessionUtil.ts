/*
 * Copyright 2021 WPPConnect Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {
  create,
  CreateOptions,
  SocketState,
  StatusFind,
  Wid,
} from '@wppconnect-team/wppconnect';
import { Request } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as proxyChain from 'proxy-chain';

import { WhatsAppServer } from '../types/WhatsAppServer';
import chatWootClient from './chatWootClient';
import { autoDownload, callWebHook, startHelper } from './functions';
import getAllTokens from './getAllTokens';
import { SessionBackupUtil } from './sessionsBackup';
import { clientsArray, eventEmitter } from './sessionUtil';
import Factory from './tokenStore/factory';

function getMaxInstancesCount() {
  const total = os.totalmem();

  const REQUIRED_WHATSAPP_INSTANCE_MEMORY_IN_MB = 650;
  const maxInstancesCount = Math.round(
    total / 1024 / 1024 / REQUIRED_WHATSAPP_INSTANCE_MEMORY_IN_MB
  );

  return maxInstancesCount;
}

export async function canCreateNewInstance() {
  const activeSessions = await getAllTokens();
  return activeSessions.length < getMaxInstancesCount();
}

async function getLidEntry(client: WhatsAppServer, targetLid: string) {
  let lidEntry = client.lidEntryCache?.[targetLid];
  if (!lidEntry) {
    try {
      lidEntry = await client.getPnLidEntry(targetLid);
      client.lidEntryCache = {
        ...client.lidEntryCache,
        [targetLid]: lidEntry,
      };
    } catch (_err) {}
  }
  return lidEntry;
}

function isLidId(id: string | Wid) {
  return typeof id === 'string'
    ? id.includes('@lid')
    : id._serialized.includes('@lid');
}

export default class CreateSessionUtil {
  startChatWootClient(client: any) {
    if (client.config.chatWoot && !client._chatWootClient)
      client._chatWootClient = new chatWootClient(
        client.config.chatWoot,
        client.session
      );
    return client._chatWootClient;
  }

  async createSessionUtil(
    req: any,
    clientsArray: any,
    session: string,
    res?: any
  ) {
    let sessionBackupUtil: SessionBackupUtil | undefined;

    try {
      let client = this.getClient(session) as any;
      if (client.status != null && client.status !== 'CLOSED') return;
      client.status = 'INITIALIZING';
      client.config = req.body;

      const tokenStore = new Factory();
      const myTokenStore = tokenStore.createTokenStory(client);
      const tokenData = await myTokenStore.getToken(session);

      // we need this to update phone in config every time session starts, so we can ask for code for it again.
      myTokenStore.setToken(session, tokenData ?? {});

      this.startChatWootClient(client);

      if (req.serverOptions.customUserDataDir) {
        req.serverOptions.createOptions.puppeteerOptions = {
          userDataDir: req.serverOptions.customUserDataDir + session,
        };
      }

      const browserArgs: string[] = [];

      if (client.config.proxy) {
        req.logger.info(
          `[${session}] try getting proxy for ${client.config.proxy}`
        );
        const newProxyUrl = await proxyChain.anonymizeProxy(
          client.config.proxy as string
        );
        req.logger.info(`[${session}] proxy setted to ${newProxyUrl}`);
        browserArgs.push(`--proxy-server=${newProxyUrl}`);
      }

      const clientCreateOptions: CreateOptions = Object.assign(
        {},
        { tokenStore: myTokenStore },
        client.config.proxy
          ? {
              proxy: {
                url: client.config.proxy?.url,
                username: client.config.proxy?.username,
                password: client.config.proxy?.password,
              },
            }
          : {},
        req.serverOptions.createOptions,
        {
          browserArgs: [
            ...browserArgs,
            ...(req.serverOptions.createOptions?.browserArgs || []),
          ],
          session: session,
          phoneNumber: client.config.phone ?? null,
          deviceName:
            client.config.phone == undefined // bug when using phone code this shouldn't be passed (https://github.com/wppconnect-team/wppconnect-server/issues/1687#issuecomment-2099357874)
              ? client.config?.deviceName ||
                req.serverOptions.deviceName ||
                'WppConnect'
              : undefined,
          poweredBy:
            client.config.phone == undefined // bug when using phone code this shouldn't be passed (https://github.com/wppconnect-team/wppconnect-server/issues/1687#issuecomment-2099357874)
              ? client.config?.poweredBy ||
                req.serverOptions.poweredBy ||
                'WPPConnect-Server'
              : undefined,
          catchLinkCode: (code: string) => {
            this.exportPhoneCode(req, client.config.phone, code, client, res);
          },
          catchQR: (
            base64Qr: any,
            asciiQR: any,
            attempt: any,
            urlCode: string
          ) => {
            this.exportQR(req, base64Qr, urlCode, client, res);
          },
          onLoadingScreen: (percent: string, message: string) => {
            req.logger.info(`[${session}] ${percent}% - ${message}`);
          },
          statusFind: async (statusFind: StatusFind) => {
            try {
              eventEmitter.emit(`status-${client.session}`, client, statusFind);
              if (
                statusFind === StatusFind.autocloseCalled ||
                statusFind === StatusFind.disconnectedMobile ||
                statusFind === StatusFind.qrReadError
              ) {
                client.status = 'CLOSED';
                client.qrcode = null;

                try {
                  await client.close?.();
                } catch (_error) {
                  req.logger.error(
                    '[${session}] Error closing session ' + session
                  );
                }

                clientsArray[session] = undefined;

                // remove session data if qr read error
                if (statusFind === StatusFind.qrReadError) {
                  const pathToken = path.join(
                    __dirname + `../../../tokens/${session}.data.json`
                  );
                  if (fs.existsSync(pathToken)) {
                    await fs.promises.rm(pathToken);
                  }
                  req.logger.info(
                    `[${session}] Removed session json and browser data`
                  );
                }
              }
              callWebHook(client, req, 'status-find', {
                status: statusFind.toString(),
                session: client.session,
              });
              req.logger.info(statusFind.toString() + '\n\n');
            } catch (error) {
              req.logger.info(`[${session}] Error finding status`);
              req.logger.error(error);
            }
          },
        }
      );

      sessionBackupUtil = new SessionBackupUtil({
        clientId: session,
        dataPath: req.serverOptions.customUserDataDir,
        clientCreateOptions,
      });
      await sessionBackupUtil.beforeBrowserInitialized();

      const wppClient = await create(clientCreateOptions);

      client = clientsArray[session] = Object.assign(wppClient, client);
      await this.start(req, client);

      await client.isConnected();
      await sessionBackupUtil?.afterAuthReady();
      startHelper(client, req);

      if (req.serverOptions.webhook.onParticipantsChanged) {
        await this.onParticipantsChanged(req, client);
      }

      if (req.serverOptions.webhook.onReactionMessage) {
        await this.onReactionMessage(client, req);
      }

      if (req.serverOptions.webhook.onRevokedMessage) {
        await this.onRevokedMessage(client, req);
      }

      if (req.serverOptions.webhook.onPollResponse) {
        await this.onPollResponse(client, req);
      }
      if (req.serverOptions.webhook.onLabelUpdated) {
        await this.onLabelUpdated(client, req);
      }
    } catch (e) {
      req.logger.error(e);
      if (e instanceof Error && e.name == 'TimeoutError') {
        console.log(`TimeoutError on session ${session}`);
        console.log(e);
        const client = this.getClient(session) as any;
        client.status = 'CLOSED';
        client.close();
        sessionBackupUtil?.disconnect();
      }
    }
  }

  async opendata(req: Request, session: string, res?: any) {
    await this.createSessionUtil(req, clientsArray, session, res);
  }

  exportPhoneCode(
    req: any,
    phone: any,
    phoneCode: any,
    client: WhatsAppServer,
    res?: any
  ) {
    eventEmitter.emit(`phoneCode-${client.session}`, phoneCode, client);

    Object.assign(client, {
      status: 'PHONECODE',
      phoneCode: phoneCode,
      phone: phone,
    });

    req.io.emit('phoneCode', {
      data: phoneCode,
      phone: phone,
      session: client.session,
    });

    callWebHook(client, req, 'phoneCode', {
      phoneCode: phoneCode,
      phone: phone,
      session: client.session,
    });

    if (res && !res._headerSent)
      res.status(200).json({
        status: 'phoneCode',
        phone: phone,
        phoneCode: phoneCode,
        session: client.session,
      });
  }

  exportQR(
    req: any,
    qrCode: any,
    urlCode: any,
    client: WhatsAppServer,
    res?: any
  ) {
    eventEmitter.emit(`qrcode-${client.session}`, qrCode, urlCode, client);
    Object.assign(client, {
      status: 'QRCODE',
      qrcode: qrCode,
      urlcode: urlCode,
    });

    qrCode = qrCode.replace('data:image/png;base64,', '');
    const imageBuffer = Buffer.from(qrCode, 'base64');

    req.io.emit('qrCode', {
      data: 'data:image/png;base64,' + imageBuffer.toString('base64'),
      session: client.session,
    });

    callWebHook(client, req, 'qrcode', {
      qrcode: qrCode,
      urlcode: urlCode,
      session: client.session,
    });
    if (res && !res._headerSent)
      res.status(200).json({
        status: 'qrcode',
        qrcode: qrCode,
        urlcode: urlCode,
        session: client.session,
      });
  }

  async onParticipantsChanged(req: any, client: any) {
    await client.isConnected();
    await client.onParticipantsChanged((message: any) => {
      callWebHook(client, req, 'onparticipantschanged', message);
    });
  }

  async start(req: Request, client: WhatsAppServer) {
    try {
      await client.isConnected();
      Object.assign(client, { status: 'CONNECTED', qrcode: null });

      req.logger.info(`Started Session: ${client.session}`);
      callWebHook(client, req, 'state_change', { status: 'CONNECTED' });
      req.io.emit('session-logged', { status: true, session: client.session });
      startHelper(client, req);
    } catch (error) {
      req.logger.error(error);
      req.io.emit('session-error', client.session);
    }

    await this.checkStateSession(client, req);
    await this.listenMessages(client, req);

    if (req.serverOptions.webhook.listenAcks) {
      await this.listenAcks(client, req);
    }

    if (req.serverOptions.webhook.onPresenceChanged) {
      await this.onPresenceChanged(client, req);
    }
  }

  async checkStateSession(client: WhatsAppServer, req: Request) {
    await client.onStateChange((state) => {
      req.logger.info(`State Change ${state}: ${client.session}`);
      const conflits = [SocketState.CONFLICT];

      if (conflits.includes(state)) {
        client.useHere();
      }

      callWebHook(client, req, 'state_change', { status: state });
    });
  }

  async listenMessages(client: WhatsAppServer, req: Request) {
    await client.onAnyMessage(async (message) => {
      (message as any).session = client.session;

      if (isLidId(message.chatId)) {
        const targetLid =
          typeof message.chatId === 'string'
            ? message.chatId
            : message.chatId._serialized;

        const lidEntry = await getLidEntry(client, targetLid);
        (message as any).chatEntry = lidEntry;
      }

      if (isLidId(message.sender.id)) {
        const targetLid = message.sender.id;
        const lidEntry = await getLidEntry(client, targetLid);
        (message.sender as any).lidEntry = lidEntry;
      }

      if (
        req.serverOptions?.websocket?.autoDownload ||
        req.serverOptions?.webhook?.autoDownload
      ) {
        await autoDownload(client, req, message);
      }
      eventEmitter.emit(`mensagem-${client.session}`, client, message);
      callWebHook(client, req, 'onmessage', message);
      if (message.type === 'location')
        client.onLiveLocation(message.sender.id, (location) => {
          callWebHook(client, req, 'location', location);
        });
    });

    await client.onAnyMessage(async (message: any) => {
      message.session = client.session;

      if (
        req.serverOptions?.websocket?.autoDownload ||
        (req.serverOptions?.webhook?.autoDownload && message.fromMe == false)
      ) {
        await autoDownload(client, req, message);
      }

      req.io.emit('received-message', { response: message });
      if (req.serverOptions.webhook.onSelfMessage && message.fromMe)
        callWebHook(client, req, 'onselfmessage', message);
    });

    await client.onIncomingCall(async (call) => {
      if (isLidId(call.peerJid)) {
        const lidEntry = await getLidEntry(client, call.peerJid);
        (call as any).peerEntry = lidEntry;
      }
      req.io.emit('incomingcall', call);
      callWebHook(client, req, 'incomingcall', call);
    });
  }

  async listenAcks(client: WhatsAppServer, req: Request) {
    await client.onAck(async (ack) => {
      req.io.emit('onack', ack);
      callWebHook(client, req, 'onack', ack);
    });
  }

  async onPresenceChanged(client: WhatsAppServer, req: Request) {
    await client.onPresenceChanged(async (presenceChangedEvent) => {
      req.io.emit('onpresencechanged', presenceChangedEvent);
      callWebHook(client, req, 'onpresencechanged', presenceChangedEvent);
    });
  }

  async onReactionMessage(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onReactionMessage(async (reaction: any) => {
      req.io.emit('onreactionmessage', reaction);
      callWebHook(client, req, 'onreactionmessage', reaction);
    });
  }

  async onRevokedMessage(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onRevokedMessage(async (response: any) => {
      req.io.emit('onrevokedmessage', response);
      callWebHook(client, req, 'onrevokedmessage', response);
    });
  }
  async onPollResponse(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onPollResponse(async (response: any) => {
      req.io.emit('onpollresponse', response);
      callWebHook(client, req, 'onpollresponse', response);
    });
  }
  async onLabelUpdated(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onUpdateLabel(async (response: any) => {
      req.io.emit('onupdatelabel', response);
      callWebHook(client, req, 'onupdatelabel', response);
    });
  }

  encodeFunction(data: any, webhook: any) {
    data.webhook = webhook;
    return JSON.stringify(data);
  }

  decodeFunction(text: any, client: any) {
    const object = JSON.parse(text);
    if (object.webhook && !client.webhook) client.webhook = object.webhook;
    delete object.webhook;
    return object;
  }

  getClient(session: any) {
    let client = clientsArray[session];
    if (!client)
      client = clientsArray[session] = {
        status: null,
        session: session,
      };
    return client;
  }
}
