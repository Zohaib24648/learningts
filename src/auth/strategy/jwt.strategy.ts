//auth/strategy/jwt.strategy.ts
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

export class JwtStrategy extends PassportStrategy(Strategy,
    'jwt') 
    
    {
    constructor(){
        super({
            jwtFromRequest:ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration:false,
            secretOrKey:process.env.JWT_SECRET,
        })
    }

    async validate(payload:any){
        return {userId:payload.sub,email:payload.email,role:payload.role}
    }   

    
}