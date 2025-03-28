import * as admin from "firebase-admin";
import * as functions from "firebase-functions";
import moment from "moment";
import { requestErrorHandler } from "./error-handler";
import { logMessage } from "./log-message";
import { BodyPayload, CustomerInfo, is } from "./types";
import { validateAndGetPayload } from "./validate-and-get-payload";
import { validateApiVersion } from "./validate-api-version";

import { getEventarc } from "firebase-admin/eventarc";
import { Auth } from "firebase-admin/lib/auth/auth";


const eventChannel = process.env.EVENTARC_CHANNEL
  ? getEventarc().channel(process.env.EVENTARC_CHANNEL, {
      allowedEventTypes: process.env.EXT_SELECTED_EVENTS,
    })
  : null;

const SHARED_SECRET = process.env.REVENUECAT_SHARED_SECRET as string;
const EVENTS_COLLECTION = process.env.REVENUECAT_EVENTS_COLLECTION as
  | string
  | undefined;
const CUSTOMERS_COLLECTION = process.env.REVENUECAT_CUSTOMERS_COLLECTION as
  | string
  | undefined;
const CUSTOMERS_FIELD = process.env.REVENUECAT_CUSTOMERS_FIELD as
  | string
  | undefined;
const SET_CUSTOM_CLAIMS = process.env.SET_CUSTOM_CLAIMS as
  | "ENABLED"
  | "DISABLED";
const DATABASE_URL = process.env.DATABASE_URL as
  | string
  | undefined;
const EXTENSION_VERSION = process.env.EXTENSION_VERSION || "0.1.17";

if (DATABASE_URL === undefined) {
    admin.initializeApp();
} else {
    admin.initializeApp({
        databaseURL: DATABASE_URL
    });
}

const writeToCollection = async ({
  firestore,
  customersCollectionConfig,
  userId,
  customerPayload,
  aliases,
}: {
  firestore: admin.firestore.Firestore;
  customersCollectionConfig: string;
  userId: string;
  customerPayload: BodyPayload["customer_info"];
  aliases: string[];
}) => {

  const customersCollection = firestore.collection(customersCollectionConfig);
  const field = CUSTOMERS_FIELD;

  const payloadToWrite = {
    ...customerPayload,
    aliases,
  };

  const data = field ? { [field]: payloadToWrite } : payloadToWrite;

  await customersCollection.doc(userId).set(data, { merge: true });
  await customersCollection.doc(userId).update(data);
};

const getActiveEntitlements = ({
  customerPayload,
}: {
  customerPayload: CustomerInfo;
}): string[] => {
  return Object.keys(customerPayload.entitlements).filter((entitlementID) => {
    const expiresDate =
      customerPayload.entitlements[entitlementID].expires_date;
    return expiresDate === null || moment.utc(expiresDate) >= moment.utc();
  });
};

const setCustomClaims = async ({
  auth,
  userId,
  entitlements,
}: {
  auth: Auth;
  userId: string;
  entitlements: string[];
}) => {
  try {
    const { customClaims } = await auth.getUser(userId);
    await admin.auth().setCustomUserClaims(userId, {
      ...(customClaims ? customClaims : {}),
      revenueCatEntitlements: entitlements,
    });
  } catch (userError) {
    logMessage(`Error saving user ${userId}: ${userError}`, "error");
  }
};

export const handler = functions.https.onRequest(async (request, response) => {
  try {
    response.header("X-EXTENSION-VERSION", EXTENSION_VERSION);

    const bodyPayload = validateAndGetPayload(SHARED_SECRET)(
      request
    ) as BodyPayload;
    validateApiVersion(bodyPayload, EXTENSION_VERSION);

    const firestore = admin.firestore();
    const auth = admin.auth();

    const eventPayload = bodyPayload.event;
    const customerPayload = bodyPayload.customer_info;
    const destinationUserId = eventPayload.app_user_id;

    const eventType = (eventPayload.type || "").toLowerCase();

    if (EVENTS_COLLECTION) {
      const eventsCollection = firestore.collection(EVENTS_COLLECTION);
      await eventsCollection.doc(eventPayload.id).set(eventPayload);
    }

    if (CUSTOMERS_COLLECTION) {
      if (destinationUserId) {
        await writeToCollection({
          firestore,
          customersCollectionConfig: CUSTOMERS_COLLECTION,
          userId: destinationUserId,
          customerPayload,
          aliases: eventPayload.aliases,
        });
      }

      if (is(bodyPayload, "TRANSFER")) {
        await writeToCollection({
          firestore,
          customersCollectionConfig: CUSTOMERS_COLLECTION,
          userId: bodyPayload.event.origin_app_user_id,
          customerPayload: bodyPayload.origin_customer_info,
          aliases: bodyPayload.event.transferred_from,
        });
      }
    }

    if (SET_CUSTOM_CLAIMS === "ENABLED" && destinationUserId) {
      const activeEntitlements = getActiveEntitlements({ customerPayload });

      await setCustomClaims({
        auth,
        userId: destinationUserId,
        entitlements: activeEntitlements,
      });

      if (is(bodyPayload, "TRANSFER")) {
        const originActiveEntitlements = getActiveEntitlements({
          customerPayload: bodyPayload.origin_customer_info,
        });
        await setCustomClaims({
          auth,
          userId: bodyPayload.event.origin_app_user_id,
          entitlements: originActiveEntitlements,
        });
      }
    }

    await eventChannel?.publish({
      type: `com.revenuecat.v1.${eventType}`,
      data: eventPayload,
    });

    response.send({});
  } catch (err) {
    requestErrorHandler(err as Error, response, EXTENSION_VERSION);
  }
});
