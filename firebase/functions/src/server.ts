import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { getAuth } from "firebase-admin/auth";

import {
  reserveUsernameAndCreateProfileHandler,
  linkWalletHandler,
  publishChatRequestHandler,
  verifyFCCOnboardingHandler,
  switchLinkedWalletHandler,
} from "./index.js";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "KnockKnock Backend",
  });
});

/**
 * Verify the Firebase ID token sent by the frontend.
 *
 * The decoded token is stored in res.locals so the Render
 * adapter can recreate the Firebase CallableRequest shape
 * expected by the existing handlers.
 */
async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authorization = req.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
      res.status(401).json({
        error: "unauthenticated",
        message: "Firebase ID token is required.",
      });
      return;
    }

    const idToken = authorization.substring("Bearer ".length);

    const decodedToken = await getAuth().verifyIdToken(idToken);

    res.locals.uid = decodedToken.uid;
    res.locals.token = decodedToken;

    next();
  } catch (error) {
    console.error("Authentication failed:", error);

    res.status(401).json({
      error: "unauthenticated",
      message: "Invalid or expired Firebase ID token.",
    });
  }
}

/**
 * Recreate the relevant Firebase CallableRequest structure.
 *
 * Existing handlers expect:
 *
 * request.data
 * request.auth.uid
 * request.auth.token
 */
function makeCallableRequest<T>(
  req: Request,
  res: Response,
): {
  data: T;
  auth: {
    uid: string;
    token: Record<string, unknown>;
  };
} {
  const uid = res.locals.uid as string | undefined;
  const token = res.locals.token as Record<string, unknown> | undefined;

  if (!uid) {
    throw new Error("Authenticated UID missing.");
  }

  if (!token) {
    throw new Error("Authenticated Firebase token missing.");
  }

  return {
    data: req.body as T,
    auth: {
      uid,
      token,
    },
  };
}

/* ================================================================ */
/* Reserve Username                                                 */
/* ================================================================ */

app.post(
  "/api/reserveUsernameAndCreateProfile",
  authenticate,
  async (req, res) => {
    try {
      const result =
        await reserveUsernameAndCreateProfileHandler(
          makeCallableRequest(req, res) as any,
        );

      res.json(result);
    } catch (error: any) {
      console.error(
        "reserveUsernameAndCreateProfile:",
        error,
      );

      res.status(400).json({
        error: error?.code ?? "internal",
        message:
          error?.message ??
          "Request failed.",
      });
    }
  },
);

/* ================================================================ */
/* Link Wallet                                                      */
/* ================================================================ */

app.post(
  "/api/linkWallet",
  authenticate,
  async (req, res) => {
    try {
      const result =
        await linkWalletHandler(
          makeCallableRequest(req, res) as any,
        );

      res.json(result);
    } catch (error: any) {
      console.error(
        "linkWallet:",
        error,
      );

      res.status(400).json({
        error: error?.code ?? "internal",
        message:
          error?.message ??
          "Request failed.",
      });
    }
  },
);

/* ================================================================ */
/* Publish Chat Request                                             */
/* ================================================================ */

app.post(
  "/api/publishChatRequest",
  authenticate,
  async (req, res) => {
    try {
      const result =
        await publishChatRequestHandler(
          makeCallableRequest(req, res) as any,
        );

      res.json(result);
    } catch (error: any) {
      console.error(
        "publishChatRequest:",
        error,
      );

      res.status(400).json({
        error: error?.code ?? "internal",
        message:
          error?.message ??
          "Request failed.",
      });
    }
  },
);

/* ================================================================ */
/* FCC Onboarding Verification                                      */
/* ================================================================ */

app.post(
  "/api/verifyFCCOnboarding",
  authenticate,
  async (req, res) => {
    try {
      const result =
        await verifyFCCOnboardingHandler(
          makeCallableRequest(req, res) as any,
        );

      res.json(result);
    } catch (error: any) {
      console.error(
        "verifyFCCOnboarding:",
        error,
      );

      res.status(400).json({
        error: error?.code ?? "internal",
        message:
          error?.message ??
          "Request failed.",
      });
    }
  },
);

/* ================================================================ */
/* Switch Linked Wallet                                             */
/* ================================================================ */

app.post(
  "/api/switchLinkedWallet",
  authenticate,
  async (req, res) => {
    try {
      const result =
        await switchLinkedWalletHandler(
          makeCallableRequest(req, res) as any,
        );

      res.json(result);
    } catch (error: any) {
      console.error(
        "switchLinkedWallet:",
        error,
      );

      res.status(400).json({
        error: error?.code ?? "internal",
        message:
          error?.message ??
          "Request failed.",
      });
    }
  },
);

/* ================================================================ */
/* Start Server                                                      */
/* ================================================================ */

const PORT =
  Number(process.env.PORT) || 10000;

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `KnockKnock backend listening on port ${PORT}`,
    );
  },
);