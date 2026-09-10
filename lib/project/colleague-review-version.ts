import {createHash} from 'node:crypto';
import {canonicalJson} from '../domain/canonical-json';
import {colleagueReviewSchema,type ColleagueReview} from '../domain/colleague-review';
import type {FolderProject} from './package';
import {preparePublicationPackage} from './publication-package';
/** Reuses visible-content preparation, not the publication lifecycle. Nothing is published.
 * The caller must authorize the request and supply its exact archived project/dependencies.
 * The result contains only visible slides and referenced, verified images, never the archive.
 */
export async function prepareColleagueReviewVersion(source:FolderProject,input:ColleagueReview,readImage:(hash:string)=>Promise<Uint8Array|undefined>){
 const review=colleagueReviewSchema.parse(input),snapshot=structuredClone(source);
 if(snapshot.state.doc.id!==review.documentId||snapshot.state.revision!==review.target.revision||createHash('sha256').update(canonicalJson(snapshot.state.doc)).digest('hex')!==review.target.documentHash)
  throw Error('Содержимое не совпадает с версией, отправленной на проверку.');
 const prepared=await preparePublicationPackage(snapshot,{tenantId:review.tenantId,materialId:review.documentId,publicationId:review.id,expectedRevision:review.target.revision,createdAt:review.createdAt},readImage);
 const version={format:'lanka-colleague-review-version/v1' as const,reviewId:review.id,documentId:review.documentId,
  target:structuredClone(review.target),evidence:'visible-content-not-fact-verification' as const,
  document:prepared.payload.document,sources:prepared.payload.sources,dependencies:prepared.payload.dependencies};
 return {version,blobs:prepared.blobs};
}
