import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preparePublicationRequest, type PublicationKind } from '../../src/server/modules/participation/publication-preparation.js';

// Retained from the complete preparation output of 32d52f4, before extraction.
const digests: Record<string, string> =
{
  "discussion.create/v1": "f47a435eaff3e52db1ccf8ca1c755dc72ec3b63a0a6f71569be7e688b422209f",
  "reply.create/v1": "9210762da8132f82e6a83a7aae986e104b41e0ecf289ac728274db2a14ef1923",
  "artifact.create/v1": "845945e03768698d25e87ea6a4aebe1b9a80d16f476a66b1e888d5cbf28592e5",
  "revision.publish/v1": "75a04386c01c59d301512f2ce560446b3ab3060c717fd0dd7a8171deca8433b0",
  "community.setup/v1": "f40625da64fbf765323ac411d7233012e6a1a17bb2defe6618ad87dfabe47607",
  "summary.create/v1": "2cf1d9ac1a1460b8b64bc17442ae8343a36b3ed3664d87bc59599b0f2e240459",
  "summary.revise/v1": "2d2d3c878fbc932ed5fa4b6a2b17bf1a6007915c005cba72c5861c595ae8f0a2",
  "discussion.create/v2": "de42d0f026a426739572ce924a392bd2edb3ae539d5602eee23fe8973402767c",
  "reply.create/v2": "c1ab7bc22dd5883bc289e7afc62be0b6027a4007546a557e29a57fcda485ee2b",
  "artifact.create/v2": "c399b6d6d2e1f9a3e6dc66cadc13806504f8743b7c1122f037e036fc949b43b3",
  "revision.publish/v2": "65ef6c76230e67c07e05639c8501e5fb0ef4b58070dd0f3c2e2ebd2f8841b509",
  "community.setup/v2": "5460563348ce6fef587d01c50c94d7c49b439c4ba52b653d6a0d75673b01324e",
  "summary.create/v2": "8cc3764fdd45b910127a3f9e834013718f60ded3721581e2d68f82a71357c191",
  "summary.revise/v2": "5a8e1ef777a556dd9ebf3ed581b096940b4aa0d6d824399e62e5247c8efd5223",
  "discussion.create/v3": "235ad5fcdc84f033cab6ebb55f22e55eda31dbdbb31a04a8bc7b4f4b8543c285",
  "reply.create/v3": "fcf95f2af83732cbc81ab5c60961315e8785f165141f4eca998317e0cf7da681",
  "artifact.create/v3": "b44c639a57f2d59484861991dc1ef508677e067fb74dfefda492f9aceb54b7cc",
  "revision.publish/v3": "a6e79590506e3649e38f319d4484106986a83e1c93cdd52a8e368171ed3799f2",
  "community.setup/v3": "7778c56ceabc5de8f9913c223e989b0d1708dd69a1fc89695ed9f17c3336a87f",
  "summary.create/v3": "ecdc77034703c02c05d3eb4f76a75743ae2addf914473e8f3883eee94ed1c49a",
  "summary.revise/v3": "3261ed47a4da5634e4912d71155d6256b5efebf2f8c351ae5b6b7339c7b123d4",
  "artifact.create/v3/files": "bc352894ea86b3dd1a5d3813855d1e625c895267efed2f60921f865f8024045c",
  "revision.publish/v3/files": "bc1fdff2e73525d34697aeb3b958db3cea4541eeda6a70df4c24a9d129e0811c",
  "discussion.create/v3/files": "8d9999287ebdcbae25e88541e82f9a747a284f61dc44c4dd20db5c9aaf7348aa",
  "reply.create/v3/files": "416e604f2e6e2f0b7c9323924b517dce567d41055bc92e8d3a01980a579cbd7c",
  "discussion.create/v4": "49d3b9d22de970810dc84d57282d7dfa647b95f85307e945dfbe9f0fa140c055",
  "reply.create/v4": "471472a8510be0d9eef513ccad59576fceeb6ff63901c8e1d63911f1cf0d3ecf",
  "artifact.create/v4": "09715b2ab84cd7f5638d2ff70a070d5ab64fb1451e7bf695c1418d58e34758cf",
  "revision.publish/v4": "656fb48d9b0811c2a3c737f474f7467584ae6b984d07d59bdccea19e8083e86f",
  "community.setup/v4": "3184e07d723d4d0d125f980299fbd66034d86fa8559272c33845a08ead7e13fb",
  "summary.create/v4": "3c9334f0555f9675958fa197d664ca25481e371837c0c9e44fab1514fddff08d",
  "summary.revise/v4": "fc462c64641de467d73eeb9c6053f0110a5f7a7d5455b00ac3f6ec4775ee3608",
  "artifact.create/v4/files": "63ce3630ea1b2ed6894b61e8bab99c15d3c4c66ff7374243615647e00dd4b10f",
  "revision.publish/v4/files": "833cf3e904905879972c94ae9d79f46119189cc26212c7d95dd4da3e08340412",
  "discussion.create/v4/files": "fabfaf90779b7e8b5a559b082d3ea4a4241e270d3d6b66ee61781ec99745a069",
  "reply.create/v4/files": "cb5c7c6d123e9288777ceb70dd170f96f3e01621449d124361b7a14eb9fb5136"
};
const A = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', B = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
for (const n of [1, 2, 3, 4]) {
  const content = {
    format: `loom-markdown-v${n}`, text: ' Exact\r\nUnicode é [[mention:z]] and [[mention:a]] ',
    mentions: [{ token: 'z', participant_id: B }, { token: 'a', participant_id: A }],
    ...(n > 1 ? { references: [
      { reference_id: B, target: { kind: 'artifact', resource_id: B, revision_id: A, ...(n === 4 ? { file_id: B, path: 'Cafe\u0301/file.txt' } : {}) }, relationship: 'related_to', rationale: ' Keep é\r\n ' },
      { reference_id: A, target: { kind: 'discussion', resource_id: A }, relationship: null, rationale: null },
    ] } : {}),
  };
  const expectedContent = {
    format: `loom-markdown-v${n}`, text: ' Exact\r\nUnicode é [[mention:z]] and [[mention:a]] ',
    mentions: [{ token: 'a', participant_id: a }, { token: 'z', participant_id: b }],
    ...(n > 1 ? { references: [
      { reference_id: a, target: { kind: 'discussion', resource_id: a }, relationship: null, rationale: null },
      { reference_id: b, target: { kind: 'artifact', resource_id: b, revision_id: a, ...(n === 4 ? { file_id: b, path: 'Café/file.txt' } : {}) }, relationship: 'related_to', rationale: ' Keep é\r\n ' },
    ] } : {}),
  };
  const common = { idempotency_key: A, ...(n >= 3 ? { change_note: null, change_account: null } : {}) };
  const expectedCommon = { idempotency_key: a, ...(n >= 3 ? { change_note: null, change_account: null } : {}) };
  const authored = { ...common, title: ' Title é ', content };
  const expectedAuthored = { ...expectedCommon, title: ' Title é ', content: expectedContent };
  const requests: [PublicationKind, object, object][] = [
    ['discussion.create', { ...authored, area_id: B, proposal_context: { expected_settings_version: 2, affected_area_id: A } },
      { ...expectedAuthored, area_id: b, proposal_context: { expected_settings_version: 2, affected_area_id: a } }],
    ['reply.create', { ...common, content, discussion_id: A, parent_id: B },
      { ...expectedCommon, content: expectedContent, discussion_id: a, parent_id: b }],
    ['artifact.create', { ...authored, area_id: B }, { ...expectedAuthored, area_id: b }],
    ['revision.publish', { ...authored, title: null, resource_id: B, expected_revision_id: A },
      { ...expectedAuthored, title: null, resource_id: b, expected_revision_id: a }],
    ['community.setup', { ...common, overview: content, community_name: 'Community', ordinary_area_name: 'Work', proposal_area_name: 'Proposals' },
      { ...expectedCommon, overview: expectedContent, community_name: 'Community', ordinary_area_name: 'Work', proposal_area_name: 'Proposals' }],
    ['summary.create', { ...authored, discussion_id: B, coverage: { preparation_id: A } },
      { ...expectedAuthored, discussion_id: b, coverage: { preparation_id: a } }],
    ['summary.revise', { ...authored, resource_id: B, expected_revision_id: A, coverage: { carry_forward_revision_id: A } },
      { ...expectedAuthored, resource_id: b, expected_revision_id: a, coverage: { carry_forward_revision_id: a } }],
  ];
  function check(name: string, kind: PublicationKind, input: object, expectedInput: object, envelope?: string) {
    test(name + ' preserves the complete normalized body, version and retained digest', () => {
      const original = structuredClone(input);
      const version = n === 4
        ? kind.startsWith('summary.') ? 'discussion-summary-v3' : 'participation-text-v4'
        : envelope ?? (kind.startsWith('summary.') ? n === 3 ? 'discussion-summary-v2' : 'discussion-summary-v1' : `participation-text-v${n}`);
      assert.deepEqual(preparePublicationRequest(kind, input), {
        kind, input: expectedInput, content: expectedContent, version, digest: digests[name],
      });
      assert.deepEqual(input, original);
      // Key aliases and object insertion order do not change semantic identity.
      const reordered = Object.fromEntries(Object.entries(input).reverse());
      reordered.idempotency_key = B;
      const prepared = preparePublicationRequest(kind, reordered);
      assert.equal(prepared.digest, digests[name]);
      assert.equal(prepared.input.idempotency_key, b);
    });
  }
  for (const [kind, input, expectedInput] of requests) {
    check(`${kind}/v${n}`, kind, input, expectedInput);
    if (n < 3 || !['artifact.create', 'revision.publish', 'discussion.create', 'reply.create'].includes(kind)) continue;
    const artifact = kind === 'artifact.create' || kind === 'revision.publish';
    const field = artifact ? 'file_set' : 'attachment_set';
    const version = artifact ? 'artifact-files-v1' : 'contribution-attachments-v1';
    check(`${kind}/v${n}/files`, kind,
      { ...input, [field]: { version, files: [{ path: 'z.txt', source: { upload_id: B } }, { path: 'Cafe\u0301/a.txt', source: { revision_id: B, file_id: A } }] } },
      { ...expectedInput, [field]: { version, files: [{ path: 'Café/a.txt', source: { revision_id: b, file_id: a } }, { path: 'z.txt', source: { upload_id: b } }] } }, version);
  }
}
