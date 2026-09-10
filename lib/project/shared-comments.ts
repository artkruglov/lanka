export type CommentStatusEvent={delegationId?:string;version:number;resolved:boolean;actorPrincipalId:string;author:string;createdAt:string};
export type SharedComment = {
 delegationId?:string;
 id:string;slideId:string;text:string;author:string;authorPrincipalId:string;
 createdAt:string;resolved:boolean;revision:number;replyTo?:string;statusVersion:number;statusHistory:CommentStatusEvent[];anchor?:{elementId:string;quote:string;revision:number};
};
export type SharedCommentsView = {revision:number;canComment:boolean;manageableIds:string[];comments:SharedComment[]};
export type SharedCommentRequest = {requestId:string;expectedRevision:number;slideId:string;text:string;replyTo?:string;elementId?:string};

export type SharedCommentStatusRequest={requestId:string;action:"set_status";commentId:string;expectedStatusVersion:number;resolved:boolean};
export type SharedDiscussionRequest=SharedCommentRequest|SharedCommentStatusRequest;
