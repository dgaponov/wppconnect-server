import { Whatsapp } from '@wppconnect-team/wppconnect';

export interface WhatsAppServer extends Whatsapp {
  urlcode: string;
  status: string;
  lidEntryCache?: Record<
    string,
    import('@wppconnect/wa-js/dist/contact').PnLidEntryResult
  >;
}
