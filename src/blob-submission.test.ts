import {
  parseGwei,
  bytesToHex,
  Hex,
  Abi,
  commitmentToVersionedHash,
  getContractAddress,
  parseEventLogs,
  encodeFunctionData,
  SendRawTransactionErrorType,
} from "viem";
import { client, account } from "./client.js";
import { viemKzg as kzg } from "./viem-kzg.js";
import cKzg from "c-kzg";
const { BYTES_PER_BLOB } = cKzg;
import * as path from "path";
import { readJsonFile } from "./utils/json-io.js";

import { fileURLToPath } from "url";
import { dirname } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let abi: Abi;
let bytecode: Hex;
let deployedContractAddress: `0x${string}`;

// Deploy the blob submission contract (Blob.sol):
async function deployBlobSubmissionContract() {
  const artifactPath = path.join(
    __dirname,
    "..",
    "contracts",
    "out",
    "Blob.sol",
    "Blob.json"
  );

  let data: any;
  try {
    data = await readJsonFile(artifactPath);
  } catch (error) {
    console.error("Error reading JSON file:", error);
  }

  abi = data.abi as Abi;
  bytecode = data.bytecode.object;

  const myAddress = (await client.getAddresses())[0];

  const deploymentHash = await client.deployContract({
    account,
    abi,
    bytecode,
  });

  let nonce = BigInt(
    (await client.getTransactionCount({
      address: myAddress,
    })) - 1
  );
  deployedContractAddress = getContractAddress({
    from: myAddress,
    nonce,
  });
}

let blob: Uint8Array;
let versionedHash: Uint8Array;
let inputBytes: Buffer;
let input: `0x${string}`;

function createBlobData() {
  // Construct a blob:

  // Let's design the blob so that we know some of the evaluations of p(X), so that we can validate this is all working correctly.

  /**
   * Not to scale ;)
   *
   *        |
   * 0xabcd |            *
   *        |
   * 0x1234 |     *
   *        |
   *   0x69 |                   *
   *        |_______________________
   *              0      1      2
   *
   * p(X) would roughly interpolate these values.
   * Except the x-coords aren't ascending integers; they're roots of unity.
   * Not only that, but they're arranged in bit-reversal permutation, which needs
   * a codebase of its own. I played with the python functions in the eth consensus
   * specs to deduce a mapping from {0, 1, 2} above to the bit-reversal-permutation
   * roots of unity:
   * 0 -> 1
   * 1 -> 52435875175126190479447740508185965837690552500527637822603658699938581184512
   *      = 0x73EDA753299D7D483339D80809A1D80553BDA402FFFE5BFEFFFFFFFF00000000
   *      (which is actually `-1` in the scalar field)
   * 2 -> ok I haven't computed this yet.
   *
   *
   * So to test the point evaluation precompile:
   *
   * C = commitment to the blob
   *
   * p(X) interpolation of the blob
   *
   * z0 = 1
   * z1 = 0x73EDA753299D7D483339D80809A1D80553BDA402FFFE5BFEFFFFFFFF00000000
   * z2 = ?
   *
   * y0 = p(z0) = 0x1234
   * y1 = p(z1) = 0xabcd
   * y2 = p(z2) = 0x69
   *
   * proof0 = commitment to q0(X) = (p(X) - p(z0)) / (X - z0)
   * proof1 = commitment to q1(X) = (p(X) - p(z1)) / (X - z1)
   */
  blob = Buffer.alloc(BYTES_PER_BLOB);
  (blob as Buffer).write("1234", 32 - 2, 2, "hex");
  (blob as Buffer).write("abcd", 2 * 32 - 2, 2, "hex"); // each value is offset by a 32-byte 'Field' (as per the definition of "Field" in the eip-4844 spec).
  (blob as Buffer).write("69", 3 * 32 - 1, 1, "hex");

  const commitment = kzg.blobToKzgCommitment(blob);

  {
    // These are the 0th and 1th roots of unity, taken from the eth consensus specs python lib.
    let z0 = Buffer.alloc(32);
    (z0 as Buffer).write("01", 31, "hex");
    let z1 = Buffer.alloc(32);
    (z1 as Buffer).write(
      "73EDA753299D7D483339D80809A1D80553BDA402FFFE5BFEFFFFFFFF00000000",
      0,
      "hex"
    );

    // Notice: we have to move away from viem's restricted kzg methods and access the underlying
    // cKzg methods, to compute a point at a z value that we can specify.
    const [proof0, y0] = cKzg.computeKzgProof(blob, z0);
    expect(bytesToHex(y0)).toBe(bytesToHex(blob.slice(0, 32)));

    const [proof1, y1] = cKzg.computeKzgProof(blob, z1);
    expect(bytesToHex(y1)).toBe(bytesToHex(blob.slice(32, 64)));
  }

  let z = Buffer.alloc(32);
  (z as Buffer).write("02", 31, "hex");
  const [proof, y] = cKzg.computeKzgProof(blob, z);
  expect(bytesToHex(y)).toBe(
    "0x049a902c5b4968d755b6f49c0231e15af80c62e352a428e8e9842eadc1c106bd"
  );

  versionedHash = commitmentToVersionedHash({ commitment });

  inputBytes = Buffer.concat([versionedHash, z, y, commitment, proof]);
  expect(inputBytes.length).toBe(192);

  input = bytesToHex(inputBytes);
}

beforeAll(async () => {
  await deployBlobSubmissionContract();
  createBlobData();
});

test("Test basic blob submission to nowhere", async () => {
  // First send just a blob to no particular contract or function:

  const basicBlobRequest = await client.prepareTransactionRequest({
    blobs: [blob],
    kzg,
    maxFeePerBlobGas: parseGwei("30"),
    to: "0x0000000000000000000000000000000000000000",
    maxPriorityFeePerGas: 1_000_000_000n,
    maxFeePerGas: 2_051_413_230n,
    gas: 10_000_000n,
  });

  const basicBlobSerializedTransaction = await client.signTransaction(
    basicBlobRequest
  );

  // A Hardhat Network Node can only cope with blob transactions which are sent as raw transactions.
  // An Anvil node seemingly can't cope with blob transactions.
  // So let's send it as a raw transaction for the hardhat node's benefit.
  const basicBlobHash = await client.sendRawTransaction({
    serializedTransaction: basicBlobSerializedTransaction,
  });
});

test("Test blob submission", async () => {
  // Now the actual tx I want: sending a blob AND calling a particular function.

  const submitBlobsFunctionData = encodeFunctionData({
    abi,
    functionName: "submitBlobs",
  });

  const submitBlobsRequest = await client.prepareTransactionRequest({
    blobs: [blob],
    kzg,
    maxFeePerBlobGas: parseGwei("30"),
    to: deployedContractAddress,
    data: submitBlobsFunctionData,
    // Interestingly, specifying these gas amounts enables hardhat to cope with this. Otherwise it makes an estimateGas call, and when it makes that call, it doesn't do a `send RAW Transaction` (it does a normal `sendTransaction`, so that breaks the hardhat node (it can't deal with non-raw blobby txs https://github.com/NomicFoundation/hardhat/issues/5182).
    maxPriorityFeePerGas: 1_000_000_000n,
    maxFeePerGas: 2_051_413_230n,
    gas: 10_000_000n,
  });

  const serializedTransaction = await client.signTransaction(
    submitBlobsRequest
  );

  // A Hardhat Network Node can only cope with blob transactions which are sent as raw transactions.
  // An Anvil node seemingly can't cope with blob transactions.
  // So let's send it as a raw transaction for the hardhat node's benefit.
  const submitBlobsHash = await client.sendRawTransaction({
    serializedTransaction,
  });

  const submitBlobsReceipt = await client.getTransactionReceipt({
    hash: submitBlobsHash,
  });

  const submitBlobsLogs = parseEventLogs({
    abi,
    logs: submitBlobsReceipt.logs,
  });

  expect(submitBlobsLogs[0].eventName).toBe("BlobHash");
  expect(submitBlobsLogs[0].args.hasOwnProperty("_blobhash")).toBe(true);
  if ("_blobhash" in submitBlobsLogs[0].args) {
    expect(submitBlobsLogs[0].args?._blobhash).toBe(bytesToHex(versionedHash));
  }

  //*************************************** */

  // Now let's verify the kzg proof on-chain:

  const verifyKzgProofFunctionData = encodeFunctionData({
    abi,
    functionName: "verifyKzgProof",
    args: [input, 0],
  });

  const verifyKzgProofRequest = await client.prepareTransactionRequest({
    to: deployedContractAddress,
    data: verifyKzgProofFunctionData,
  });

  const verifyKzgProofSerializedTransaction = await client.signTransaction(
    verifyKzgProofRequest
  );

  const verifyKzgProofHash = await client.sendRawTransaction({
    serializedTransaction: verifyKzgProofSerializedTransaction,
  });

  const verifyKzgProofReceipt = await client.getTransactionReceipt({
    hash: verifyKzgProofHash,
  });

  const verifyKzgProofLogs = parseEventLogs({
    abi,
    logs: verifyKzgProofReceipt.logs,
  });

  expect(verifyKzgProofLogs[0].eventName).toBe("PointEvaluationSuccess");
  expect(verifyKzgProofLogs[0].args.hasOwnProperty("_success")).toBe(true);
  if ("_success" in verifyKzgProofLogs[0].args) {
    expect(verifyKzgProofLogs[0].args?._success).toBe(true);
  }

  //*************************************** */

  // Now let's validate than an invalid input to `verifyKzgProof` will fail:

  let badInputBytes = inputBytes;
  badInputBytes.write("00", 100, "hex");
  const badInput = bytesToHex(badInputBytes);

  const badVerifyKzgProofFunctionData = encodeFunctionData({
    abi,
    functionName: "verifyKzgProof",
    args: [badInput, 0],
  });

  const badVerifyKzgProofRequest = await client.prepareTransactionRequest({
    to: deployedContractAddress,
    data: badVerifyKzgProofFunctionData,
    // Interestingly, specifying these gas amounts enables hardhat to cope with this:
    maxPriorityFeePerGas: 1_000_000_000n,
    maxFeePerGas: 2_051_413_230n,
    gas: 10_000_000n,
  });

  const badVerifyKzgProofSerializedTransaction = await client.signTransaction(
    badVerifyKzgProofRequest
  );

  let badVerifyKzgProofHash: Hex;
  try {
    badVerifyKzgProofHash = await client.sendRawTransaction({
      serializedTransaction: badVerifyKzgProofSerializedTransaction,
    });
  } catch (e) {
    const error = e as SendRawTransactionErrorType;
    expect(error.name).toBe("InvalidInputRpcError");
    if (error.name === "InvalidInputRpcError") {
      expect(error.details).toBe(
        "reverted with reason string 'Point evaluation precompile failed'"
      );
    }
  }

  //*************************************** */
});
