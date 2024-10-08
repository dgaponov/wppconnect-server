import { FileTokenStore as fsTokenStore } from './FileTokenStore/FileTokenStore';
import config from '../../config';

class FileTokenStore {
  declare client: any;
  constructor(client: any) {
    this.client = client;
  }
  tokenStore = new fsTokenStore({
    encodeFunction: (data) => {
      return this.encodeFunction(data, this.client.config);
    },
    decodeFunction: (text) => {
      return this.decodeFunction(text, this.client);
    },
    // @ts-ignore
    path: config.tokenStorePath as string,
  });

  public encodeFunction(data: any, config: any) {
    data.config = config;
    return JSON.stringify(data);
  }

  public async decodeFunction(text: string, client: any): Promise<string[]> {
    const object = JSON.parse(text);
    if (object.config && Object.keys(client.config).length === 0)
      client.config = object.config;
    if (object.webhook && Object.keys(client.config).length === 0)
      client.config.webhook = object.webhook;
    if (object.proxy && Object.keys(client.config).length === 0)
      client.config.proxy = object.proxy;
    return object;
  }
}

export default FileTokenStore;
