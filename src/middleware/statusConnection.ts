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

import { NextFunction, Request, Response } from 'express';

import { contactToArray } from '../util/functions';

export default async function statusConnection(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (req.client && req.client.isConnected) {
      await req.client.isConnected();
    } else {
      res.status(404).json({
        response: null,
        status: 'Disconnected',
        message: 'A sessão do WhatsApp não está ativa.',
      });
    }
    next();
  } catch (error) {
    req.logger.error(error);
    res.status(404).json({
      response: null,
      status: 'Disconnected',
      message: 'A sessão do WhatsApp não está ativa.',
    });
  }
}
