/**
 * CLI for managing food-agent pairing/allowlist.
 * Usage:
 *   npm run pairing -- list        List pending requests
 *   npm run pairing -- approve <code>  Approve a pairing code
 *   npm run pairing -- users       List approved users
 */

import {
  listPairingRequests,
  approvePairingCode,
  listApprovedUsers,
} from "./pairing.js";

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "list": {
    const requests = listPairingRequests();
    if (requests.length === 0) {
      console.log("No pending pairing requests.");
    } else {
      console.log("Pending pairing requests:\n");
      for (const r of requests) {
        console.log(`  Code: ${r.code}`);
        console.log(`  From: ${r.sender} (ID: ${r.senderId})`);
        console.log(`  Created: ${r.createdAt}`);
        console.log("");
      }
    }
    break;
  }

  case "approve": {
    const code = args[1];
    if (!code) {
      console.error("Usage: npm run pairing -- approve <code>");
      process.exit(1);
    }
    const result = approvePairingCode(code);
    if (result.success) {
      console.log(
        `Approved! User ${result.request!.sender} (${result.request!.senderId}) can now use the bot.`,
      );
    } else {
      console.error(
        `No pending request found for code "${code}". It may have expired.`,
      );
      process.exit(1);
    }
    break;
  }

  case "users": {
    const users = listApprovedUsers();
    if (users.length === 0) {
      console.log("No approved users.");
    } else {
      console.log("Approved users:\n");
      for (const u of users) {
        console.log(`  ${u.sender} (ID: ${u.senderId}) — approved ${u.approvedAt}`);
      }
    }
    break;
  }

  default:
    console.log("Usage:");
    console.log("  npm run pairing -- list           List pending requests");
    console.log("  npm run pairing -- approve <code>  Approve a pairing code");
    console.log("  npm run pairing -- users          List approved users");
}
