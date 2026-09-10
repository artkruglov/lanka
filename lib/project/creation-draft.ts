import { z } from "zod";
import { createPresentationSchema } from "../agents/contracts";

const savedSchema=z.object({text:z.string().max(8000),materialName:z.string().max(140).optional(),materialText:z.string().max(12000).optional(),sourceIntakeId:z.string().uuid().optional(),intakePreviewId:z.string().uuid().optional(),profile:z.enum(["focus-v2","focus-v3"]).optional(),pending:createPresentationSchema.optional()});
/** Preserve the same request across a lost response and a tab reload. */
export class CreationDraft {
  private value:z.infer<typeof savedSchema>={text:""};
  persistent:boolean;
  constructor(private storage:Pick<Storage,"getItem"|"setItem">|null) {
    this.persistent=!!storage;
    try { const raw=storage?.getItem("lanka:creation-draft:v1");if(raw)this.value=savedSchema.parse(JSON.parse(raw)); } catch { this.persistent=false; }
  }
  get profile(){return this.value.profile||this.value.pending?.profile||(this.value.pending?"focus-v2":"focus-v3");}
  setProfile(profile:"focus-v2"|"focus-v3"){this.value.profile=profile;this.save();}
  get materialName(){return this.value.materialName||"Исходные материалы";}
  get materialText(){return this.value.materialText||"";}
  setMaterial(name:string,text:string){this.value.materialName=name.slice(0,140);this.value.materialText=text.slice(0,12000);this.save();}
  get text(){return this.value.text;}
  get sourceIntakeId(){return this.value.sourceIntakeId;}
  get intakePreviewId(){return this.value.intakePreviewId||this.sourceIntakeId;}
  setIntakePreview(id:string|undefined){this.value.intakePreviewId=id;this.save();}
  setSourceIntake(id:string|undefined){this.value.sourceIntakeId=id;this.save();}
  private save(){try{this.storage?.setItem("lanka:creation-draft:v1",JSON.stringify(this.value));}catch{this.persistent=false;}}
  setText(text:string){this.value.text=text.slice(0,8000);this.save();}
  prepare(folderId:string|null){
    const old=this.value.pending;
    const next=createPresentationSchema.parse({requestId:old?.requestId||crypto.randomUUID(),prompt:this.text,folderId,profile:this.profile,...(this.sourceIntakeId?{sourceIntakeId:this.sourceIntakeId}:{}),...(this.materialText.trim()?{material:{name:this.materialName,text:this.materialText}}:{})});
    this.value.pending=old&&old.prompt===next.prompt&&old.folderId===folderId&&old.sourceIntakeId===next.sourceIntakeId&&JSON.stringify(old.material)===JSON.stringify(next.material)&&(old.profile||"focus-v2")===next.profile?old:{...next,requestId:old?crypto.randomUUID():next.requestId};
    this.save();return this.value.pending;
  }
  acknowledge(){this.value={text:"",profile:this.profile};this.save();}
}
