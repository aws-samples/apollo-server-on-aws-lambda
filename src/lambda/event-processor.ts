import { EventBridgeEvent } from 'aws-lambda';

const AWSXRay = require('aws-xray-sdk-core');
const AWS = AWSXRay.captureAWS(require('aws-sdk'));

const translateClient = new AWS.Translate();

const eventBridge = new AWS.EventBridge({
  region: process.env.AWS_REGION,
});

export interface IRequestEventDetails {
  chatId: string;
  message: string;
}

export async function translateMessage(event: EventBridgeEvent<'EventResponse', IRequestEventDetails>): Promise<any> {
  const translateResult = await translateClient.translateText({
    Text: event.detail.message,
    TargetLanguageCode: process.env.TARGET_LANGUAGE_CODE!,
    SourceLanguageCode: 'auto',
  }).promise();

  return eventBridge.putEvents({
    Entries: [
      {
        Source: `translate.${process.env.TARGET_LANGUAGE_CODE!}`,
        EventBusName: process.env.BUS_NAME,
        DetailType: process.env.RESPONSE_EVENT_DETAIL_TYPE,
        Time: new Date(),
        Detail: JSON.stringify({
          message: `'${event.detail.message}' in ${process.env.TARGET_LANGUAGE_CODE!}: '${translateResult.TranslatedText}'`,
          chatId: event.detail.chatId,
        }),
      },
    ],
  }).promise();
}
