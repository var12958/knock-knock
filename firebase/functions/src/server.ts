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
    next();
  } catch (error) {
    console.error("Authentication failed:", error);

    res.status(401).json({
      error: "unauthenticated",
      message: "Invalid or expired Firebase ID token.",
    });
  }
}

function makeCallableRequest<T>(req: Request) {
  return {
    data: req.body as T,
    auth: {
      uid: resUid(req),
    },
  };
}

function resUid(req: Request): string {
  const uid = (req as Request & { uid?: string }).uid;
  if (uid) return uid;

  throw new Error("Authenticated UID missing.");
}

app.use((req, _res, next) => {
  const uid = req.res?.locals.uid;

  if (uid) {
    (req as Request & { uid?: string }).uid = uid;
  }

  next();
});

app.post("/api/reserveUsernameAndCreateProfile", authenticate, async (req, res) => {
  try {
    const result = await reserveUsernameAndCreateProfileHandler({
      data: req.body,
      auth: {
        uid: res.locals.uid,
      },
    } as any);

    res.json(result);
  } catch (error: any) {
    console.error("reserveUsernameAndCreateProfile:", error);

    res.status(400).json({
      error: error?.code ?? "internal",
      message: error?.message ?? "Request failed.",
    });
  }
});

app.post("/api/linkWallet", authenticate, async (req, res) => {
  try {
    const result = await linkWalletHandler({
      data: req.body,
      auth: {
        uid: res.locals.uid,
      },
    } as any);

    res.json(result);
  } catch (error: any) {
    console.error("linkWallet:", error);

    res.status(400).json({
      error: error?.code ?? "internal",
      message: error?.message ?? "Request failed.",
    });
  }
});

app.post("/api/publishChatRequest", authenticate, async (req, res) => {
  try {
    const result = await publishChatRequestHandler({
      data: req.body,
      auth: {
        uid: res.locals.uid,
      },
    } as any);

    res.json(result);
  } catch (error: any) {
    console.error("publishChatRequest:", error);

    res.status(400).json({
      error: error?.code ?? "internal",
      message: error?.message ?? "Request failed.",
    });
  }
});

app.post("/api/verifyFCCOnboarding", authenticate, async (req, res) => {
  try {
    const result = await verifyFCCOnboardingHandler({
      data: req.body,
      auth: {
        uid: res.locals.uid,
      },
    } as any);

    res.json(result);
  } catch (error: any) {
    console.error("verifyFCCOnboarding:", error);

    res.status(400).json({
      error: error?.code ?? "internal",
      message: error?.message ?? "Request failed.",
    });
  }
});

app.post("/api/switchLinkedWallet", authenticate, async (req, res) => {
  try {
    const result = await switchLinkedWalletHandler({
      data: req.body,
      auth: {
        uid: res.locals.uid,
      },
    } as any);

    res.json(result);
  } catch (error: any) {
    console.error("switchLinkedWallet:", error);

    res.status(400).json({
      error: error?.code ?? "internal",
      message: error?.message ?? "Request failed.",
    });
  }
});

const PORT = Number(process.env.PORT) || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`KnockKnock backend listening on port ${PORT}`);
});